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

function externalStatusFor(sessionId: string | null): ExternalSessionStatus | null {
  if (!sessionId) return null;
  const e = externalSessions.get(sessionId);
  return e ? { pid: e.pid, account: e.account, kind: e.kind, status: e.status } : null;
}


// Module-level settings shared across WS connections. Phone toggles update
// this; new prompts use the latest values.
let agentSettings: AgentSettings = {
  autoApproveTools: false,
  effort: 'max',
  perToolAuto: {},
};

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
      }
      switch (emit.kind) {
        case 'agent_event': {
          const tid = r.turnId() || '';
          send({ type: 'agent_event', turnId: tid, seq: emit.seq, event: emit.event });
          return;
        }
        case 'turn_done':
          send({ type: 'turn_done' });
          return;
        case 'error':
          send({ type: 'error', message: emit.message });
          return;
      }
    });
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

      if (msg.type === 'interrupt') {
        if (myRunner) await myRunner.interrupt();
        return;
      }

      if (msg.type === 'tool_response') {
        if (myRunner) myRunner.respondToTool(msg.toolUseId, {
          allow: msg.decision === 'allow',
          allowRestOfTurn: msg.allowRestOfTurn,
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
        if (typeof msg.autoApproveTools === 'boolean') {
          agentSettings.autoApproveTools = msg.autoApproveTools;
        }
        if (msg.effort) {
          agentSettings.effort = msg.effort;
        }
        if (msg.perToolAuto) {
          agentSettings.perToolAuto = { ...(agentSettings.perToolAuto ?? {}), ...msg.perToolAuto };
        }
        send({ type: 'settings', settings: agentSettings });
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
          r.start({
            prompt: msg.text,
            images: msg.images,
            cwd: myCurrentCwd,
            sessionId: myCurrentSessionId,
            effort: agentSettings.effort,
            autoApproveAllTools: agentSettings.autoApproveTools,
            autoApproveTools: agentSettings.perToolAuto,
          });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
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
      stopHeartbeat();
      ws = null;
    },
  };
}
