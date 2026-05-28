// WebSocket layer — thin adapter between WS connections and the singleton
// TurnRunner. The runner is module-level so that closing a WS does not
// terminate the in-flight turn; on reconnect, we replay the buffered events
// from the runner and re-attach.
//
// Session state (currentSessionId, currentCwd) is also module-level —
// all WS clients see the same logical "phone agent session". For now this is
// single-tenant by design (one user, one home machine).

import type { Hono } from 'hono';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { TurnRunner } from './runner.ts';
import { defaultAgent, ownerOfSession } from './agents/registry.ts';

type WSLike = { send(data: string): void; close(code?: number, reason?: string): void };
type Cfg = { TOKEN: string; DEFAULT_CWD: string };

// Singleton runner; reused across WS connects.
let runner: TurnRunner | null = null;
function getRunner(): TurnRunner {
  if (!runner) runner = new TurnRunner(defaultAgent());
  return runner;
}

// Shared cross-connection state.
let currentSessionId: string | null = null;
let currentCwd: string | null = null;

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
  if (currentCwd === null) currentCwd = cfg.DEFAULT_CWD;
  app.get('/ws', upgradeWebSocket((c: any) => createHandler(c, cfg)));
}

function createHandler(c: any, cfg: Cfg) {
  const tokenOk = c.req.query('token') === cfg.TOKEN;
  let ws: WSLike | null = null;
  let unsubscribe: (() => void) | null = null;

  const send = (msg: ServerMessage) => { if (ws) ws.send(JSON.stringify(msg)); };

  return {
    onOpen(_evt: any, w: WSLike) {
      ws = w;
      if (!tokenOk) {
        send({ type: 'unauthorized' });
        w.close(4001, 'unauthorized');
        return;
      }

      const r = getRunner();

      send({
        type: 'connected',
        defaultCwd: cfg.DEFAULT_CWD,
        currentCwd: currentCwd || cfg.DEFAULT_CWD,
        currentSessionId,
        claudeAccount: deriveAccountName(),
        activeTurn: r.activeState(),
      });

      unsubscribe = r.subscribe((emit) => {
        // Capture session_id from agent and surface it as session_set so
        // the phone (and all other attached devices) move to the new id.
        if (emit.kind === 'agent_event' && emit.event.kind === 'session_init') {
          if (!currentSessionId) {
            currentSessionId = emit.event.sessionId;
            send({
              type: 'session_set',
              sessionId: emit.event.sessionId,
              cwd: currentCwd || cfg.DEFAULT_CWD,
            });
          }
        }
        switch (emit.kind) {
          case 'agent_event':
            send({ type: 'agent_event', event: emit.event });
            return;
          case 'turn_done':
            send({ type: 'turn_done' });
            return;
          case 'error':
            send({ type: 'error', message: emit.message });
            return;
        }
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

      const r = getRunner();

      if (msg.type === 'select_session') {
        if (r.isActive()) {
          try { await r.interrupt(); } catch { /* ignore */ }
        }
        currentSessionId = msg.sessionId;
        if (msg.cwd) currentCwd = msg.cwd;
        if (msg.sessionId) {
          const owner = await ownerOfSession(msg.sessionId);
          if (owner) r.setAgent(owner);
        } else {
          // new session → keep current agent (or could surface explicit choice later)
        }
        send({
          type: 'session_set',
          sessionId: currentSessionId,
          cwd: currentCwd || cfg.DEFAULT_CWD,
        });
        return;
      }

      if (msg.type === 'interrupt') {
        await r.interrupt();
        return;
      }

      if (msg.type === 'tool_response') {
        r.respondToTool(msg.toolUseId, {
          allow: msg.decision === 'allow',
          allowRestOfTurn: msg.allowRestOfTurn,
        });
        return;
      }

      if (msg.type === 'prompt') {
        if (r.isActive()) {
          send({ type: 'error', message: '上一个对话还在进行' });
          return;
        }
        try {
          r.start({
            prompt: msg.text,
            images: msg.images,
            cwd: currentCwd || cfg.DEFAULT_CWD,
            sessionId: currentSessionId,
          });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    },

    onClose() {
      // CRITICAL: do NOT interrupt the runner — the turn keeps running so
      // the next reconnect can replay all events.
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      ws = null;
    },
  };
}
