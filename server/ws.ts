// WebSocket dispatcher + per-connection agent runner.
// - One active query at a time per connection.
// - SDK partial-message stream events are normalized to small AgentEvent
//   objects so the frontend doesn't see the raw Anthropic Beta event shape.
// - canUseTool round-trips through the WebSocket: server pauses the tool
//   call until the client sends a {type:'tool_response'} matching the id.

import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import { query, type Query, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, ClientMessage, ServerMessage } from '../shared/types.ts';

type WSLike = { send(data: string): void; close(code?: number, reason?: string): void };

type Cfg = { TOKEN: string; DEFAULT_CWD: string };

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

  // Per-connection state
  let ws: WSLike | null = null;
  let currentCwd: string = cfg.DEFAULT_CWD;
  let currentSessionId: string | null = null;

  // Active query
  let activeQuery: Query | null = null;

  // Tool approval coordination
  // 1) Stream events for tool_use blocks push id onto pendingToolUseIds.
  // 2) When canUseTool fires, we pop the head id, send tool_request to client,
  //    and await tool_response.
  let pendingToolUseIds: string[] = [];
  let pendingApprovals: Map<string, (d: 'allow' | 'deny') => void> = new Map();
  let approveAllForTurn: Set<string> = new Set(); // tool names auto-approved for current turn

  // Per-message-per-block accumulator for tool_use input_json_delta.
  // Keyed by `${messageId}:${blockIndex}` → { id, name, inputJson }
  const toolUseAccum = new Map<string, { id: string; name: string; inputJson: string }>();

  const send = (msg: ServerMessage) => { if (ws) ws.send(JSON.stringify(msg)); };

  return {
    onOpen(_evt: any, w: WSLike) {
      ws = w;
      if (!tokenOk) {
        send({ type: 'unauthorized' });
        w.close(4001, 'unauthorized');
        return;
      }
      send({
        type: 'connected',
        defaultCwd: cfg.DEFAULT_CWD,
        currentCwd,
        currentSessionId,
        claudeAccount: deriveAccountName(),
      });
    },

    async onMessage(evt: any, w: WSLike) {
      if (!tokenOk) return;
      ws = w;

      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(evt.data));
      } catch {
        send({ type: 'error', message: 'malformed message' });
        return;
      }

      // ────────────────────────────────────────────────────────
      // session / cwd selection
      // ────────────────────────────────────────────────────────
      if (msg.type === 'select_session') {
        // Interrupt any active query first so it doesn't bleed into the new session.
        if (activeQuery) {
          try { await activeQuery.interrupt(); } catch { /* ignore */ }
          activeQuery = null;
        }
        currentSessionId = msg.sessionId;
        if (msg.cwd) currentCwd = msg.cwd;
        send({ type: 'session_set', sessionId: currentSessionId, cwd: currentCwd });
        return;
      }

      // ────────────────────────────────────────────────────────
      // interrupt
      // ────────────────────────────────────────────────────────
      if (msg.type === 'interrupt') {
        if (activeQuery) {
          try { await activeQuery.interrupt(); } catch (err) { console.error('interrupt err:', err); }
        }
        return;
      }

      // ────────────────────────────────────────────────────────
      // tool approval response
      // ────────────────────────────────────────────────────────
      if (msg.type === 'tool_response') {
        const resolver = pendingApprovals.get(msg.toolUseId);
        if (resolver) {
          if (msg.allowRestOfTurn && msg.decision === 'allow') {
            // mark the tool name as auto-approved for the rest of this turn
            // we look up the name from accumulators (id might still be there) or skip
            for (const [, acc] of toolUseAccum) {
              if (acc.id === msg.toolUseId) { approveAllForTurn.add(acc.name); break; }
            }
          }
          resolver(msg.decision);
          pendingApprovals.delete(msg.toolUseId);
        }
        return;
      }

      // ────────────────────────────────────────────────────────
      // prompt → run a turn
      // ────────────────────────────────────────────────────────
      if (msg.type === 'prompt') {
        if (activeQuery) {
          send({ type: 'error', message: '上一个对话还在进行' });
          return;
        }

        // Validate cwd (allow non-existent; SDK will error if invalid). But warn nicely.
        if (currentCwd && !existsSync(currentCwd)) {
          send({ type: 'error', message: `工作目录不存在: ${currentCwd}` });
          return;
        }

        // Reset per-turn state
        pendingToolUseIds = [];
        approveAllForTurn = new Set();
        toolUseAccum.clear();

        const canUseTool: CanUseTool = async (toolName, input) => {
          // Always pop a queued tool_use_id so the queue stays in sync with the
          // actual SDK calls, even when we auto-approve.
          const toolUseId = pendingToolUseIds.shift() ?? `pending-${Math.random().toString(36).slice(2, 10)}`;
          if (approveAllForTurn.has(toolName)) {
            send({ type: 'tool_request', toolUseId, toolName, input, autoApproved: true });
            return { behavior: 'allow', updatedInput: input } satisfies PermissionResult;
          }
          const decision = await new Promise<'allow' | 'deny'>((resolve) => {
            pendingApprovals.set(toolUseId, resolve);
            send({ type: 'tool_request', toolUseId, toolName, input });
          });
          if (decision === 'allow') {
            return { behavior: 'allow', updatedInput: input } satisfies PermissionResult;
          }
          return {
            behavior: 'deny',
            message: '用户在手机端拒绝了这个工具调用。',
            interrupt: false,
          } as unknown as PermissionResult;
        };

        try {
          activeQuery = query({
            prompt: msg.text,
            options: {
              cwd: currentCwd,
              ...(currentSessionId ? { resume: currentSessionId } : {}),
              permissionMode: 'default',
              canUseTool,
              includePartialMessages: true,
            },
          });

          for await (const sdkMsg of activeQuery) {
            const m = sdkMsg as any;

            // Capture session id from any message that carries it
            if (!currentSessionId && typeof m?.session_id === 'string') {
              currentSessionId = m.session_id;
              send({ type: 'agent_event', event: { kind: 'session_init', sessionId: m.session_id } });
              send({ type: 'session_set', sessionId: m.session_id, cwd: currentCwd });
            }

            // Partial assistant message (streaming events)
            if (m.type === 'stream_event') {
              handleStreamEvent(m, send, toolUseAccum, pendingToolUseIds);
              continue;
            }

            // Full assistant message — text was already streamed, but we use
            // this to capture finalized tool_use blocks (some SDK versions
            // may not always emit content_block_stop for tool_use).
            if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
              for (const block of m.message.content) {
                if (block?.type === 'tool_use' && typeof block?.id === 'string') {
                  if (!pendingToolUseIds.includes(block.id) && !pendingApprovals.has(block.id)) {
                    // ensure we tracked it
                    pendingToolUseIds.push(block.id);
                  }
                }
              }
              continue;
            }

            // tool_result comes through as a user message
            if (m.type === 'user' && Array.isArray(m.message?.content)) {
              for (const block of m.message.content) {
                if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
                  const content = stringifyToolResult(block.content);
                  send({
                    type: 'agent_event',
                    event: {
                      kind: 'tool_result',
                      toolUseId: block.tool_use_id,
                      content: content.slice(0, 8000),
                      isError: !!block.is_error,
                    },
                  });
                }
              }
              continue;
            }

            if (m.type === 'result') {
              send({
                type: 'agent_event',
                event: {
                  kind: 'result',
                  success: m.subtype === 'success',
                  durationMs: m.duration_ms ?? 0,
                  turns: m.num_turns ?? 0,
                  costUsd: m.total_cost_usd ?? 0,
                  isError: !!m.is_error,
                },
              });
              continue;
            }
          }

          send({ type: 'turn_done' });
        } catch (err) {
          console.error('query error:', err);
          send({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeQuery = null;
          // any unresolved approval is now stale
          for (const [, r] of pendingApprovals) r('deny');
          pendingApprovals.clear();
          pendingToolUseIds = [];
          toolUseAccum.clear();
        }
      }
    },

    onClose() {
      if (activeQuery) {
        activeQuery.interrupt().catch(() => {});
        activeQuery = null;
      }
      for (const [, r] of pendingApprovals) r('deny');
      pendingApprovals.clear();
      ws = null;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

function handleStreamEvent(
  m: any,
  send: (msg: ServerMessage) => void,
  toolUseAccum: Map<string, { id: string; name: string; inputJson: string }>,
  pendingToolUseIds: string[]
): void {
  const ev = m.event;
  if (!ev) return;
  const messageId = String(m.uuid ?? 'unknown');
  const blockIndex = typeof ev.index === 'number' ? ev.index : 0;
  const key = `${messageId}:${blockIndex}`;

  if (ev.type === 'content_block_start') {
    const b = ev.content_block;
    const t: 'text' | 'tool_use' | 'thinking' =
      b?.type === 'text' ? 'text' :
      b?.type === 'tool_use' ? 'tool_use' :
      b?.type === 'thinking' ? 'thinking' : 'text';
    if (t === 'tool_use' && typeof b?.id === 'string' && typeof b?.name === 'string') {
      toolUseAccum.set(key, { id: b.id, name: b.name, inputJson: '' });
      pendingToolUseIds.push(b.id);
    }
    send({
      type: 'agent_event',
      event: { kind: 'assistant_block_start', messageId, blockIndex, blockType: t },
    });
    return;
  }

  if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      send({
        type: 'agent_event',
        event: { kind: 'text_delta', messageId, blockIndex, delta: d.text },
      });
    } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      send({
        type: 'agent_event',
        event: { kind: 'thinking_delta', messageId, blockIndex, delta: d.thinking },
      });
    } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      const acc = toolUseAccum.get(key);
      if (acc) acc.inputJson += d.partial_json;
    }
    return;
  }

  if (ev.type === 'content_block_stop') {
    send({
      type: 'agent_event',
      event: { kind: 'assistant_block_end', messageId, blockIndex },
    });
    return;
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}
