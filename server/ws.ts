// WebSocket layer — adapter between WS connections and per-session TurnRunners.
//
// Architecture (v6 multi-turn):
//   - `runners` is a Map<sessionId, TurnRunner>. Each session has its own
//     runner instance that survives WS disconnects (replay buffer kept).
//   - `pendingRunner` holds the runner used by clients that haven't picked
//     a session yet (sessionId === null). When the first session_init
//     fires for that runner, we adopt it into `runners` under its real id.
//   - Each WS handler has its OWN currentSessionId/Cwd (no module-level
//     shared "focus"). Multi-device sync still works: if two devices both
//     point at session X, they both subscribe to runners.get(X) and see
//     the same stream.
//   - select_session NEVER interrupts. Switching away from a running turn
//     just unsubscribes the WS from that runner; the agent keeps going on
//     the desktop. Coming back later replays the buffer.

import { appendFile, stat, writeFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import type { AgentSettings, ClientMessage, ExternalSessionStatus, ServerMessage } from '../shared/types.ts';
import { TurnRunner } from './runner.ts';
import { defaultAgent, externalSessions, ownerOfSession } from './harness/registry.ts';
import { watchJsonl, jsonlPathFor } from './harness/cmax-external/jsonl-watcher.ts';
import { appendInjectUserMessage, appendMirrorEntry, mergeFromPhoneSession, buildHistoryPrefix } from './harness/cmax-external/jsonl-writer.ts';
import { findSessionFile } from './harness/claude-sdk/adapter.ts';
import { linkStore } from './store/links.ts';
import { attentionStore } from './store/attention.ts';
import { recordUsage } from './store/usage.ts';

function externalStatusFor(sessionId: string | null): ExternalSessionStatus | null {
  if (!sessionId) return null;
  const e = externalSessions.get(sessionId);
  return e ? { pid: e.pid, account: e.account, kind: e.kind, status: e.status } : null;
}


// Module-level settings shared across WS connections. Phone toggles update
// this; new prompts use the latest values.
//
// Phase 4: also acts as a CRDT-style single source of truth — every change
// bumps `version` and broadcasts to all connections. Clients pass the
// version they last saw in set_settings; a mismatch yields `settings_conflict`
// so two clients editing simultaneously can't silently clobber each other.
let agentSettings: AgentSettings = {
  autoApproveTools: false,
  effort: 'max',
  perToolAuto: {},
  version: 1,
};

// All currently-open WS senders. set_settings broadcasts to every entry on
// successful update so other clients see the change without polling.
const broadcasters = new Set<(msg: ServerMessage) => void>();

function broadcastAll(msg: ServerMessage): void {
  for (const b of broadcasters) {
    try { b(msg); } catch { /* ignore individual delivery failure */ }
  }
}

// Attention changes (set by the TurnRunner when it fires needs_input / error
// / done pushes) fan out to EVERY connected client so all drawers update
// their unread marker live — even for sessions a given client isn't
// subscribed to. Registered once at module load. (UX-BACKLOG #9)
attentionStore.onChange((sessionId, kind) => {
  broadcastAll({ type: 'attention', sessionId, kind });
});

const PHONE_LOG_PATH = '/tmp/agentphone-phone.log';
const PHONE_LOG_MAX_BYTES = 1_000_000;
async function appendPhoneLog(line: string): Promise<void> {
  try {
    await appendFile(PHONE_LOG_PATH, line);
    const st = await stat(PHONE_LOG_PATH);
    if (st.size > PHONE_LOG_MAX_BYTES) {
      const fs = await import('node:fs/promises');
      const buf = await fs.readFile(PHONE_LOG_PATH);
      const trimmed = buf.subarray(buf.length - Math.floor(PHONE_LOG_MAX_BYTES / 2));
      await writeFile(PHONE_LOG_PATH, trimmed);
    }
  } catch { /* logging failures should never crash the server */ }
}

type WSLike = { send(data: string): void; close(code?: number, reason?: string): void };
type Cfg = { TOKEN: string; DEFAULT_CWD: string };

// ── Per-session runner pool ──────────────────────────────────────
const runners = new Map<string, TurnRunner>();
let pendingRunner: TurnRunner | null = null;

function getRunnerForSession(sessionId: string | null): TurnRunner {
  if (sessionId === null) {
    if (!pendingRunner) pendingRunner = new TurnRunner(defaultAgent());
    return pendingRunner;
  }
  let r = runners.get(sessionId);
  if (!r) { r = new TurnRunner(defaultAgent()); runners.set(sessionId, r); }
  return r;
}

function adoptPendingAsSession(sessionId: string, r: TurnRunner): void {
  if (!runners.has(sessionId)) runners.set(sessionId, r);
  if (pendingRunner === r) pendingRunner = null;
}

/** Sessions that currently have an active (running) turn. Used by the
 *  REST sessions list to render a "running" indicator in the drawer. */
export function activeSessionIds(): Set<string> {
  const out = new Set<string>();
  for (const [sid, r] of runners) {
    if (r.isActive()) out.add(sid);
  }
  return out;
}

function deriveAccountName(): string {
  const ccd = process.env.CLAUDE_CONFIG_DIR;
  if (!ccd) return '(default)';
  return ccd.replace(/\/+$/, '').split('/').pop() || '(custom)';
}

export function mountWebSocket(
  app: Hono,
  upgradeWebSocket: (handlerFactory: (c: any) => any) => any,
  cfg: Cfg
): void {
  app.get('/ws', upgradeWebSocket((c: any) => createHandler(c, cfg)));
}

function createHandler(c: any, cfg: Cfg) {
  const tokenOk = c.req.query('token') === cfg.TOKEN;
  // Reconnect support: client sends its current session id in the URL so
  // the new handler picks up the right runner and replay buffer.
  const initialSession = (c.req.query('session') || '').trim() || null;
  const initialCwd = (c.req.query('cwd') || '').trim() || null;

  let ws: WSLike | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastPongAt = Date.now();

  // ── Per-connection focus state ──────────────────────────────
  let myCurrentSessionId: string | null = initialSession;
  let myCurrentCwd: string = initialCwd || cfg.DEFAULT_CWD;
  let myUnsubscribe: (() => void) | null = null;
  let myRunner: TurnRunner | null = null;
  // User explicitly accepted the risk of double-driving the currently-
  // selected session (e.g. desktop CLI is also on it). Resets every time
  // the session changes.
  let myTakeoverSid: string | null = null;
  let myExternalUnsubscribe: (() => void) | null = null;
  // Stop function for the per-connection jsonl-watcher. Only set when the
  // current session is externally-owned — owned sessions get their stream
  // through the TurnRunner subscribe path. Per-connection seq counter for
  // these external events; assigned a synthetic turnId tied to the session.
  let myExternalWatcherStop: (() => void) | null = null;
  let myExtSeq = 0;
  // Per-turn capture so the mirror writer can produce a (user → assistant)
  // summary when a phone-owned session finishes a turn. Set on the 'prompt'
  // path, accumulated on text_delta events, flushed + reset on turn_done.
  let myCurrentTurnPrompt: string = '';
  let myCurrentTurnAssistantText: string = '';
  // Fork-with-history one-shot prefix: stashed by the fork_session handler,
  // prepended to the very next prompt's SDK call, then cleared. mirror keeps
  // recording the user's actual text — the prefix is just context fed to
  // the API, not something we want logged into A as a giant mirror block.
  let myPendingHistoryPrefix: string | null = null;
  // Auto-link target for the post-fork session. When session_init lands for
  // this connection's pending runner, we issue linkStore.link(newSid, this).
  let myPendingForkLinkTo: string | null = null;

  const send = (msg: ServerMessage) => { if (ws) ws.send(JSON.stringify(msg)); };

  const PING_INTERVAL_MS = 25_000;
  const PONG_TIMEOUT_MS  = 60_000;

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!ws) return;
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        try { ws.close(4002, 'pong timeout'); } catch {}
        return;
      }
      send({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  /**
   * Start (or restart) a jsonl-watcher for the current session if it's owned
   * by an external claude.exe. The watcher pushes appended user/assistant/
   * tool events to this WS as `agent_event` messages, giving follow-mode
   * live updates without polling. For owned sessions this is a no-op —
   * those stream through the TurnRunner subscribe path.
   */
  function refreshExternalWatcher(sessionId: string | null): void {
    if (myExternalWatcherStop) { myExternalWatcherStop(); myExternalWatcherStop = null; }
    if (!sessionId) return;
    const ext = externalSessions.get(sessionId);
    if (!ext) return;
    const path = jsonlPathFor(ext.account, ext.cwd, sessionId);
    const turnId = `ext-${sessionId}`;
    myExternalWatcherStop = watchJsonl(path, {
      onEvent: (event) => {
        send({ type: 'agent_event', turnId, seq: myExtSeq++, event });
      },
    });
    console.log(`[ws] external watcher armed sessionId=${sessionId.slice(0, 8)} path=${path}`);
  }

  function subscribeToRunner(r: TurnRunner) {
    if (myUnsubscribe) { myUnsubscribe(); myUnsubscribe = null; }
    myRunner = r;
    myUnsubscribe = r.subscribe((emit) => {
      // When a new session is born inside the pending runner, adopt it under
      // its real id so subsequent prompts for that sessionId find the runner.
      if (emit.kind === 'agent_event' && emit.event.kind === 'session_init') {
        const newSid = emit.event.sessionId;
        if (r === pendingRunner) adoptPendingAsSession(newSid, r);
        if (!myCurrentSessionId) {
          myCurrentSessionId = newSid;
          send({ type: 'session_set', sessionId: newSid, cwd: myCurrentCwd, external: externalStatusFor(newSid) });
        }
        // fork-with-history follow-up: now that the new session has an id,
        // commit the auto-link to the source external session and tell the
        // client so the 📎 badge appears.
        if (myPendingForkLinkTo) {
          const target = myPendingForkLinkTo;
          myPendingForkLinkTo = null;
          linkStore.link(newSid, target).then(() => {
            send({ type: 'link_info', phoneSessionId: newSid, externalSessionId: target });
            console.log(`[ws] auto-linked forked phone ${newSid.slice(0, 8)} → cmax ${target.slice(0, 8)}`);
          }).catch((e) => console.warn('[ws] auto-link failed:', e?.message));
        }
      }
      switch (emit.kind) {
        case 'agent_event': {
          const tid = r.turnId() || '';
          // Capture assistant text for the mirror writer (α path). Tool ops
          // and thinking aren't included — mirror is meant to be a short
          // human-readable summary, not a full transcript.
          if (emit.event.kind === 'text_delta') {
            myCurrentTurnAssistantText += emit.event.delta;
          }
          send({ type: 'agent_event', turnId: tid, seq: emit.seq, event: emit.event });
          return;
        }
        case 'turn_done': {
          maybeWriteMirror().catch((e) => {
            console.error('[ws] mirror write failed:', e instanceof Error ? e.message : String(e));
          });
          send({ type: 'turn_done' });
          // NOTE: push notifications (done / needs_input / error) now fire
          // from the TurnRunner itself (server/runner.ts) so each fires
          // exactly once regardless of how many sockets are attached, and
          // still fires when zero sockets are attached. Don't re-push here.
          // Reset capture buffers for the next turn on this session.
          myCurrentTurnPrompt = '';
          myCurrentTurnAssistantText = '';
          return;
        }
        case 'error':
          // On error, drop the capture — we don't want a half-mirror.
          myCurrentTurnPrompt = '';
          myCurrentTurnAssistantText = '';
          send({ type: 'error', message: emit.message });
          return;
      }
    });
  }

  /** If the just-finished turn is on a phone-owned session that's linked to
   *  an external CLI session, append a mirror entry to the external jsonl. */
  async function maybeWriteMirror(): Promise<void> {
    const phoneSid = myCurrentSessionId;
    if (!phoneSid) return;
    // Phone-owned only — never mirror an external session into another
    // external session.
    if (externalSessions.get(phoneSid)) return;
    const externalSid = await linkStore.externalFor(phoneSid);
    if (!externalSid) return;
    const ext = externalSessions.get(externalSid);
    if (!ext) {
      console.warn(`[ws] mirror skipped: link target ${externalSid.slice(0, 8)} no longer alive`);
      return;
    }
    const path = jsonlPathFor(ext.account, ext.cwd, externalSid);
    await appendMirrorEntry(
      path,
      externalSid,
      myCurrentTurnPrompt,
      myCurrentTurnAssistantText,
      { phoneSessionId: phoneSid, cwd: ext.cwd },
    );
    console.log(
      `[ws] mirrored phone session ${phoneSid.slice(0, 8)} → cmax ${externalSid.slice(0, 8)} ` +
      `(${myCurrentTurnAssistantText.length} chars assistant text)`,
    );
  }

  return {
    onOpen(_evt: any, w: WSLike) {
      ws = w;
      if (!tokenOk) {
        console.log('[ws] connection rejected: bad token');
        send({ type: 'unauthorized' });
        w.close(4001, 'unauthorized');
        return;
      }
      console.log(`[ws] open sessionId=${myCurrentSessionId ?? 'new'} cwd=${myCurrentCwd}`);
      startHeartbeat();
      // Register this connection for settings broadcasts (Phase 4).
      broadcasters.add(send);

      const r = getRunnerForSession(myCurrentSessionId);
      subscribeToRunner(r);
      // If the resume-target session is externally-owned, arm the jsonl
      // watcher so follow-mode gets live events without polling.
      refreshExternalWatcher(myCurrentSessionId);

      // Watch external-session status so we can push live changes.
      if (myExternalUnsubscribe) myExternalUnsubscribe();
      myExternalUnsubscribe = externalSessions.onChange((sid, info) => {
        // Push every change so drawer/UI sync; client filters by sessionId.
        send({
          type: 'external_status',
          sessionId: sid,
          external: info
            ? { pid: info.pid, account: info.account, kind: info.kind, status: info.status }
            : null,
        });
      });

      send({
        type: 'connected',
        defaultCwd: cfg.DEFAULT_CWD,
        currentCwd: myCurrentCwd,
        currentSessionId: myCurrentSessionId,
        claudeAccount: deriveAccountName(),
        activeTurn: r.activeState(),
        settings: agentSettings,
        external: externalStatusFor(myCurrentSessionId),
      });
      // Surface any saved phone→external link for this session so the client
      // shows the 📎 badge without an extra round-trip. Fire-and-forget —
      // onOpen is sync so we can't await here.
      if (myCurrentSessionId) {
        const sid = myCurrentSessionId;
        linkStore.externalFor(sid).then((externalSid) => {
          if (externalSid) {
            send({ type: 'link_info', phoneSessionId: sid, externalSessionId: externalSid });
          }
        }).catch(() => { /* not fatal */ });
      }
    },

    async onMessage(evt: any, w: WSLike) {
      if (!tokenOk) return;
      ws = w;

      let msg: ClientMessage;
      try { msg = JSON.parse(String(evt.data)); } catch {
        send({ type: 'error', message: 'malformed message' });
        return;
      }

      if (msg.type === 'select_session') {
        // CRITICAL: never interrupt the previous session's runner — the
        // agent keeps running on the desktop. We just unsub from it and
        // sub to the new one. Coming back later replays via activeTurn.
        myCurrentSessionId = msg.sessionId;
        if (msg.cwd) myCurrentCwd = msg.cwd;
        // Switching sessions clears any takeover acknowledgment.
        myTakeoverSid = null;
        // Viewing a session = seeing it → clear its unread marker (UX #9).
        if (msg.sessionId) attentionStore.clear(msg.sessionId);

        const newRunner = getRunnerForSession(myCurrentSessionId);
        if (msg.sessionId) {
          const owner = await ownerOfSession(msg.sessionId);
          if (owner) newRunner.setAgent(owner);
        }
        subscribeToRunner(newRunner);
        // Switch the external watcher to the new session (or off if not external).
        myExtSeq = 0;
        refreshExternalWatcher(myCurrentSessionId);

        send({
          type: 'session_set',
          sessionId: myCurrentSessionId,
          cwd: myCurrentCwd,
          external: externalStatusFor(myCurrentSessionId),
        });
        if (myCurrentSessionId) {
          const externalSid = await linkStore.externalFor(myCurrentSessionId);
          if (externalSid) {
            send({ type: 'link_info', phoneSessionId: myCurrentSessionId, externalSessionId: externalSid });
          }
        }
        // Also re-send connected-style state so the client picks up the
        // new active turn (if any) and renders correctly.
        const state = newRunner.activeState();
        if (state) {
          send({
            type: 'connected',
            defaultCwd: cfg.DEFAULT_CWD,
            currentCwd: myCurrentCwd,
            currentSessionId: myCurrentSessionId,
            claudeAccount: deriveAccountName(),
            activeTurn: state,
            settings: agentSettings,
            external: externalStatusFor(myCurrentSessionId),
          });
        }
        return;
      }

      if (msg.type === 'takeover') {
        // User acknowledged the risk of double-driving. Allow prompts again
        // for THIS session id until they switch away.
        if (msg.sessionId === myCurrentSessionId) {
          myTakeoverSid = msg.sessionId;
          console.log(`[ws] takeover accepted for sessionId=${msg.sessionId}`);
        }
        return;
      }

      if (msg.type === 'mark_seen') {
        // Client viewed a session → clear its unread marker. attentionStore
        // broadcasts the cleared state to every client so all drawers sync.
        attentionStore.clear(msg.sessionId);
        return;
      }

      if (msg.type === 'usage') {
        // Local-only UX telemetry. Content-free; never leaves this machine.
        recordUsage({
          ts: Date.now(),
          name: String(msg.name || '').slice(0, 60),
          shell: msg.shell,
          form: msg.form,
          props: msg.props,
        });
        return;
      }

      if (msg.type === 'interrupt') {
        if (myRunner) await myRunner.interrupt();
        return;
      }

      if (msg.type === 'tool_response') {
        if (myRunner) myRunner.respondToTool(msg.toolUseId, {
          allow: msg.decision === 'allow',
          allowRestOfTurn: msg.allowRestOfTurn,
          reason: msg.reason,
        });
        return;
      }

      if (msg.type === 'log') {
        const ts = msg.ts ? new Date(msg.ts) : new Date();
        const iso = ts.toISOString();
        const lvl = msg.level.toUpperCase().padEnd(5);
        const line = `${iso} [${lvl}] ${msg.message}\n`;
        appendPhoneLog(line).catch(() => {});
        return;
      }

      if (msg.type === 'pong') {
        lastPongAt = Date.now();
        return;
      }

      if (msg.type === 'set_settings') {
        // Versioned-update gate (Phase 4). If the client included
        // expectedVersion and it doesn't match what we hold, another client
        // updated meanwhile — reject with settings_conflict carrying the
        // current value so the rejected client can rebase.
        if (typeof msg.expectedVersion === 'number' && msg.expectedVersion !== agentSettings.version) {
          console.log(
            `[ws] set_settings conflict: client expected v${msg.expectedVersion}, server has v${agentSettings.version}`,
          );
          send({ type: 'settings_conflict', current: agentSettings });
          return;
        }
        if (typeof msg.autoApproveTools === 'boolean') {
          agentSettings.autoApproveTools = msg.autoApproveTools;
        }
        if (msg.effort) {
          agentSettings.effort = msg.effort;
        }
        if (msg.model !== undefined) {
          // Empty string / null clears it → account/SDK default model.
          agentSettings.model = msg.model ? msg.model : undefined;
        }
        if (msg.perToolAuto) {
          agentSettings.perToolAuto = { ...(agentSettings.perToolAuto ?? {}), ...msg.perToolAuto };
        }
        agentSettings.version += 1;
        // Broadcast to every open connection so multi-client UIs stay in
        // sync without polling — the sender gets the same message too.
        const payload: ServerMessage = { type: 'settings', settings: agentSettings };
        for (const b of broadcasters) {
          try { b(payload); } catch { /* ignore individual delivery failure */ }
        }
        return;
      }

      if (msg.type === 'prompt') {
        const preview = (msg.text || '').slice(0, 80).replace(/\s+/g, ' ');
        console.log(
          `[ws] prompt sessionId=${myCurrentSessionId ?? 'new'} cwd=${myCurrentCwd} ` +
          `imgs=${msg.images?.length ?? 0} text="${preview}${(msg.text||'').length>80?'...':''}"`,
        );
        const r = myRunner;
        if (!r) {
          console.log('[ws] prompt rejected: no runner attached');
          send({ type: 'error', message: 'no runner attached' });
          return;
        }
        if (r.isActive()) {
          console.log('[ws] prompt rejected: runner already busy');
          send({ type: 'error', message: '这个 session 已经有一个回合在进行了，切换或等待' });
          return;
        }
        // Ownership rule: any session with a live external claude.exe
        // (CLI / bg job) attached is OFF-LIMITS for agentphone to drive.
        // Two SDK processes resuming the same jsonl race for assistant
        // writes — the loser exits with [ede_diagnostic] (we saw this hit
        // 99% of the time during testing). The user must create a fresh
        // session for phone-side chatting.
        //
        // Takeover used to bypass this for "idle" externals, but idle ≠
        // safe: cmax keeps a process alive watching the jsonl and will
        // pounce on any new user entry. There's no race-free way to share
        // a session between two claude.exe instances, so we just don't.
        const ext = externalStatusFor(myCurrentSessionId);
        if (ext) {
          console.log(`[ws] prompt rejected: session owned by ${ext.account} (pid=${ext.pid} status=${ext.status})`);
          send({
            type: 'error',
            message: `这个 session 由 ${ext.account} 的 CLI 拥有（pid ${ext.pid}）。两个 claude.exe 同时写一份 jsonl 会冲突，所以手机端只能 follow，不能发送。点"+ 新建"开一个手机端独占的 session。`,
          });
          return;
        }
        const totalImageBytes = (msg.images ?? []).reduce(
          (s, im) => s + Math.ceil((im.data.length * 3) / 4),
          0,
        );
        if (totalImageBytes > 20 * 1024 * 1024) {
          send({ type: 'error', message: '图片总大小超过 20MB' });
          return;
        }
        try {
          // Capture for the mirror writer (α). On turn_done the runner sub
          // checks the link store and, if linked, writes a mirror summary
          // (this prompt + accumulated assistant text) to the external
          // jsonl. Reset here so we don't carry over stale text from a
          // prior turn that errored.
          myCurrentTurnPrompt = msg.text || '';
          myCurrentTurnAssistantText = '';
          // Fork-with-history one-shot: if a previous fork_session stashed
          // an external session's history as a prefix, prepend it now and
          // clear it. The SDK sees (history + user prompt); the mirror /
          // myCurrentTurnPrompt records only the user's actual text so A's
          // jsonl mirror block doesn't double-up the history we already
          // baked in.
          let promptForSdk = msg.text || '';
          if (myPendingHistoryPrefix) {
            promptForSdk = myPendingHistoryPrefix + promptForSdk;
            console.log(`[ws] applied fork-with-history prefix (${myPendingHistoryPrefix.length} chars) to first prompt`);
            myPendingHistoryPrefix = null;
          }
          r.start({
            prompt: promptForSdk,
            images: msg.images,
            cwd: myCurrentCwd,
            sessionId: myCurrentSessionId,
            effort: agentSettings.effort,
            model: agentSettings.model,
            autoApproveAllTools: agentSettings.autoApproveTools,
            autoApproveTools: agentSettings.perToolAuto,
          });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // β path: phone wrote a message to be injected directly into a CLI-
      // owned session's jsonl. cmax sees it as a queued user prompt.
      if (msg.type === 'inject_to_external') {
        const ext = externalSessions.get(msg.sessionId);
        if (!ext) {
          console.log(`[ws] inject rejected: ${msg.sessionId.slice(0, 8)} not externally owned`);
          send({ type: 'error', message: '只能注入到外部 CLI 拥有的 session' });
          return;
        }
        const text = (msg.text || '').trim();
        if (!text) {
          send({ type: 'error', message: '内容为空' });
          return;
        }
        const path = jsonlPathFor(ext.account, ext.cwd, msg.sessionId);
        try {
          const uuid = await appendInjectUserMessage(path, msg.sessionId, text, { cwd: ext.cwd });
          console.log(
            `[ws] inject → ${ext.account}/${msg.sessionId.slice(0, 8)} ` +
            `uuid=${uuid.slice(0, 8)} text="${text.slice(0, 60).replace(/\s+/g, ' ')}"`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[ws] inject failed:`, errMsg);
          send({ type: 'error', message: '注入失败: ' + errMsg });
        }
        return;
      }

      // α path: declare a phone-session-to-CLI-session link. The mirror runs
      // on every subsequent turn_done for the linked phone session until the
      // link is replaced (with another externalSessionId) or cleared (null).
      if (msg.type === 'set_link') {
        try {
          if (msg.externalSessionId === null) {
            await linkStore.unlink(msg.phoneSessionId);
            console.log(`[ws] unlinked phone ${msg.phoneSessionId.slice(0, 8)}`);
          } else {
            await linkStore.link(msg.phoneSessionId, msg.externalSessionId);
            console.log(
              `[ws] linked phone ${msg.phoneSessionId.slice(0, 8)} → ` +
              `cmax ${msg.externalSessionId.slice(0, 8)}`,
            );
          }
          send({
            type: 'link_info',
            phoneSessionId: msg.phoneSessionId,
            externalSessionId: msg.externalSessionId,
          });
        } catch (err) {
          send({ type: 'error', message: 'link 失败: ' + (err instanceof Error ? err.message : String(err)) });
        }
        return;
      }

      // Fork-with-history: spawn a fresh phone-owned session B that
      // starts out knowing what A has discussed. We don't actually pre-
      // populate B's jsonl (the SDK assigns the id and writes the file
      // itself); instead we stash A's formatted history block on this
      // connection, prepend it to B's very first prompt, and let claude.exe
      // process (history + first user prompt) as a single API call. After
      // that B continues as its own session.
      if (msg.type === 'fork_session') {
        try {
          const ext = externalSessions.get(msg.externalSessionId);
          if (!ext) {
            send({ type: 'error', message: '源 cmax session 不在线，无法 fork' });
            return;
          }
          const path = jsonlPathFor(ext.account, ext.cwd, msg.externalSessionId);
          const prefix = await buildHistoryPrefix(path);
          if (!prefix) {
            send({ type: 'error', message: '源 session 的历史为空，没什么可 fork 的' });
            return;
          }
          // Switch this WS connection to a pending runner (new session B).
          // session_init will assign a real id; we auto-link + apply prefix
          // on the upcoming prompt path.
          myCurrentSessionId = null;
          myCurrentCwd = msg.cwd || ext.cwd;
          myTakeoverSid = null;
          myPendingHistoryPrefix = prefix;
          myPendingForkLinkTo = msg.externalSessionId;
          if (myExternalWatcherStop) { myExternalWatcherStop(); myExternalWatcherStop = null; }
          myExtSeq = 0;
          const newRunner = getRunnerForSession(null);
          subscribeToRunner(newRunner);
          send({
            type: 'session_set',
            sessionId: null,
            cwd: myCurrentCwd,
            external: null,
          });
          console.log(
            `[ws] fork_session: source=${msg.externalSessionId.slice(0, 8)} ` +
            `prefix_chars=${prefix.length} cwd=${myCurrentCwd}`,
          );
        } catch (err) {
          send({ type: 'error', message: 'fork 失败: ' + (err instanceof Error ? err.message : String(err)) });
        }
        return;
      }

      // α-plus: collapse the phone session's whole transcript into a single
      // user message and queue it in the external session's jsonl. desktop
      // presses Enter to actually consume the merged context.
      if (msg.type === 'merge_to_external') {
        try {
          const ext = externalSessions.get(msg.externalSessionId);
          if (!ext) {
            send({ type: 'error', message: '目标 cmax session 不在线' });
            return;
          }
          const phonePath = await findSessionFile(msg.phoneSessionId);
          if (!phonePath) {
            send({ type: 'error', message: '找不到手机 session 的 jsonl 文件' });
            return;
          }
          const externalPath = jsonlPathFor(ext.account, ext.cwd, msg.externalSessionId);
          const result = await mergeFromPhoneSession(
            externalPath,
            msg.externalSessionId,
            phonePath,
            { phoneSessionLabel: msg.phoneSessionId.slice(0, 8), externalCwd: ext.cwd },
          );
          console.log(
            `[ws] merged phone ${msg.phoneSessionId.slice(0, 8)} → cmax ${msg.externalSessionId.slice(0, 8)} ` +
            `(${result.turnsMerged} turns, uuid=${result.uuid.slice(0, 8)})`,
          );
          send({ type: 'error', message: `已合并 ${result.turnsMerged} 轮到 CLI queue · 桌面按 Enter 才会让 claude 处理` });
        } catch (err) {
          send({ type: 'error', message: '合并失败: ' + (err instanceof Error ? err.message : String(err)) });
        }
        return;
      }
    },

    onClose() {
      console.log(`[ws] close sessionId=${myCurrentSessionId ?? 'new'}`);
      // CRITICAL: do NOT interrupt any runner — they keep running so the
      // next reconnect can replay.
      if (myUnsubscribe) { myUnsubscribe(); myUnsubscribe = null; }
      if (myExternalUnsubscribe) { myExternalUnsubscribe(); myExternalUnsubscribe = null; }
      if (myExternalWatcherStop) { myExternalWatcherStop(); myExternalWatcherStop = null; }
      broadcasters.delete(send);
      stopHeartbeat();
      ws = null;
    },
  };
}
