// TurnRunner — single-tenant turn orchestrator.
//
// Decouples agent execution from any individual WebSocket connection so that
// the phone losing network mid-turn does not interrupt the agent. The runner:
//
//   • buffers every emit (agent_event + tool_request) keyed to the current
//     turn, so a reconnecting client can replay the full stream
//   • exposes pendingToolRequests separately so clients can render still-
//     waiting approval cards on reconnect
//   • broadcasts to all attached subscribers, supporting multi-device view
//
// The runner is a single singleton (one user, one machine, one in-flight
// turn at a time). Subsequent prompts are rejected while a turn is active.

import { randomUUID } from 'node:crypto';
import type {
  ActiveTurnState,
  AgentEvent,
  EffortLevel,
} from '../shared/types.ts';
import type {
  Agent,
  AgentTurn,
  CanUseToolFn,
} from './harness/types.ts';
import {
  sendToAll as sendPush,
  toolInputSummary,
  classifyTurnError,
  type PushPayload,
} from './push.ts';

// Everything that flows out of the runner. We unify under one shape so the
// replay buffer is a flat list. tool_request is an AgentEvent kind too — the
// distinction from 'pending vs resolved' is recovered by whether a matching
// tool_decision follows it in the stream.
//
// Every agent_event carries a monotonic seq (reset to 0 at turn start) so
// clients can do delta replay on reconnect instead of re-rendering the
// whole turn.
export type RunnerEmit =
  | { kind: 'agent_event'; event: AgentEvent; seq: number }
  | { kind: 'turn_done' }
  | { kind: 'error'; message: string };

export type RunnerListener = (emit: RunnerEmit) => void;

export class TurnRunner {
  private agent: Agent;

  private active: AgentTurn | null = null;
  private currentTurnId: string | null = null;
  private startedAtMs = 0;
  private seqCounter = 0;

  // Latest known session id for this runner — seeded from start(opts.sessionId)
  // and updated when a session_init event arrives (new sessions). Used as the
  // push notification's target so a tapped notification opens the right session.
  private currentSessionId: string | null = null;
  // Accumulated assistant text for the current turn, for the turn_done push
  // body. Reset at turn start.
  private currentTurnText = '';

  // Push notifications fire from HERE (not the per-socket WS subscriber) so
  // each event notifies exactly once regardless of how many devices are
  // attached — and crucially still fires when ZERO sockets are attached
  // (phone backgrounded / disconnected), which is the whole point of push.
  private firePush(payload: PushPayload): void {
    sendPush(payload)
      .then((r) => {
        if (r.delivered + r.pruned > 0) {
          console.log(`[push] ${payload.kind ?? 'note'} delivered=${r.delivered} pruned=${r.pruned}`);
        }
      })
      .catch((e) => console.warn(`[push] ${payload.kind ?? 'note'} fan-out failed:`, e?.message));
  }

  // Replay buffer — all emits for the current turn. Cleared at the start
  // of each new turn so we don't accumulate forever.
  private buffer: RunnerEmit[] = [];

  // Tool approvals waiting on the user.
  private pendingTools = new Map<string, {
    name: string;
    input: unknown;
    resolve: (decision: { allow: boolean; reason?: string }) => void;
  }>();

  // Tool names the user said "本轮全 approve" for.
  private approveAllForTurn = new Set<string>();

  // Subscribers — typically one per attached WS connection.
  private listeners = new Set<RunnerListener>();

  constructor(agent: Agent) {
    this.agent = agent;
  }

  setAgent(agent: Agent): void { this.agent = agent; }
  getAgent(): Agent { return this.agent; }
  isActive(): boolean { return this.active !== null; }
  turnId(): string | null { return this.currentTurnId; }

  /** Snapshot of current activity, used in WS 'connected' replay.
   *  We keep the buffer around AFTER the turn completes too — that way a
   *  phone whose network died mid-stream can reconnect after the turn
   *  finishes and still see the full reply. The buffer is reset only when
   *  a new turn starts.
   *
   *  `sinceSeq` lets the client request only events newer than what it has
   *  already rendered — used during in-turn reconnects to avoid wiping +
   *  re-rendering the whole conversation. Omit / -1 to get everything. */
  activeState(sinceSeq: number = -1): ActiveTurnState | null {
    if (!this.currentTurnId) return null;
    const events: import('../shared/types.ts').SeqEvent[] = [];
    for (const e of this.buffer) {
      if (e.kind === 'agent_event' && e.seq > sinceSeq) {
        events.push({ seq: e.seq, event: e.event });
      }
    }
    if (events.length === 0 && this.buffer.length === 0) return null;
    return {
      turnId: this.currentTurnId,
      startedAt: this.startedAtMs,
      events,
      done: this.active === null,
    };
  }

  subscribe(l: RunnerListener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private nextSeq(): number {
    return this.seqCounter++;
  }

  private broadcast(e: RunnerEmit): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* ignore listener failures */ }
    }
  }

  private record(e: RunnerEmit): void {
    this.buffer.push(e);
    this.broadcast(e);
  }

  /** Start a turn. Throws if one is already active. */
  start(opts: {
    prompt: string;
    images?: import('../shared/types.ts').ImageAttachment[];
    cwd: string;
    sessionId: string | null;
    effort?: EffortLevel;
    autoApproveAllTools?: boolean;
    /** Per-tool auto-approve list — names that bypass approval. */
    autoApproveTools?: Record<string, boolean>;
  }): string {
    if (this.active) throw new Error('上一个对话还在进行');

    this.buffer = [];
    this.pendingTools.clear();
    this.approveAllForTurn.clear();
    this.startedAtMs = Date.now();
    this.seqCounter = 0;
    this.currentSessionId = opts.sessionId;
    this.currentTurnText = '';

    const autoApproveAll = !!opts.autoApproveAllTools;
    const perToolAuto = opts.autoApproveTools ?? {};

    const canUseTool: CanUseToolFn = async (toolName, input) => {
      const toolUseId = randomUUID();

      // Auto-approve sources, in order:
      //   1. global ⚡ auto mode (autoApproveAll)
      //   2. per-tool setting (perToolAuto[toolName] === true)
      //   3. "本轮全 approve" already given for this tool name
      if (autoApproveAll || perToolAuto[toolName] === true || this.approveAllForTurn.has(toolName)) {
        this.record({
          kind: 'agent_event',
          event: { kind: 'tool_request', toolUseId, toolName, input, autoApproved: true },
          seq: this.nextSeq(),
        });
        this.record({
          kind: 'agent_event',
          event: { kind: 'tool_decision', toolUseId, allowed: true },
          seq: this.nextSeq(),
        });
        return { allow: true, updatedInput: input };
      }

      return new Promise((resolve) => {
        this.pendingTools.set(toolUseId, {
          name: toolName,
          input,
          resolve: (decision) => {
            this.record({
              kind: 'agent_event',
              event: { kind: 'tool_decision', toolUseId, allowed: decision.allow },
              seq: this.nextSeq(),
            });
            resolve({
              allow: decision.allow,
              reason: decision.reason,
            });
          },
        });
        this.record({
          kind: 'agent_event',
          event: { kind: 'tool_request', toolUseId, toolName, input, autoApproved: false },
          seq: this.nextSeq(),
        });
        // The turn is now BLOCKED waiting on the user — and turn_done will
        // never fire until they answer. This is the single most important
        // moment to notify a backgrounded phone. Fires once per pending tool.
        this.firePush({
          kind: 'needs_input',
          title: '🔔 Claude 需要确认',
          body: toolInputSummary(toolName, input),
          tag: `needs-input-${this.currentSessionId ?? this.currentTurnId ?? 'new'}`,
          url: '/launch',
          sessionId: this.currentSessionId ?? undefined,
        });
      });
    };

    const turn = this.agent.startTurn({
      prompt: opts.prompt,
      images: opts.images,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      effort: opts.effort,
      canUseTool,
    });

    this.active = turn;
    this.currentTurnId = turn.turnId;

    // Drive the iterator in the background — independent of any WS.
    (async () => {
      try {
        for await (const event of turn.iterate()) {
          // Track session id + assistant text for push bodies.
          if (event.kind === 'session_init') {
            this.currentSessionId = event.sessionId;
          } else if (event.kind === 'text_delta') {
            this.currentTurnText += event.delta;
          }
          this.record({ kind: 'agent_event', event, seq: this.nextSeq() });
        }
        this.record({ kind: 'turn_done' });
        // Turn finished cleanly → "done" push (moved here from ws.ts so it
        // fires once, not once-per-attached-socket). Body = tail of the reply.
        const body = this.currentTurnText.trim().slice(-180).replace(/\s+/g, ' ');
        this.firePush({
          kind: 'done',
          title: '✅ Claude 回完了',
          body: body || '（无文本回复，可能只用了 tool）',
          tag: `turn-${this.currentSessionId ?? 'new'}`,
          url: '/launch',
          sessionId: this.currentSessionId ?? undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        console.error(
          `[runner] turn ${turn.turnId} failed after ${Math.round((Date.now() - this.startedAtMs) / 1000)}s ` +
          `(sessionId=${opts.sessionId ?? 'new'}, cwd=${opts.cwd}): ${msg}\n${stack}`
        );
        this.record({ kind: 'error', message: msg });
        // Error while (likely) backgrounded → push so the user isn't left
        // staring at a dead "思考中". Classified (context-limit / rate-limit /
        // generic) without mis-labeling transient ede_diagnostic.
        const { title, body } = classifyTurnError(msg);
        this.firePush({
          kind: 'error',
          title,
          body,
          tag: `err-${this.currentSessionId ?? 'new'}`,
          url: '/launch',
          sessionId: this.currentSessionId ?? undefined,
        });
      } finally {
        this.active = null;
        // Resolve any tools left hanging (shouldn't happen normally) so we
        // don't leak promises.
        for (const [id, p] of this.pendingTools) {
          p.resolve({ allow: false, reason: 'turn ended before approval' });
        }
        this.pendingTools.clear();
      }
    })();

    return turn.turnId;
  }

  /** User decision on a pending tool request. */
  respondToTool(toolUseId: string, decision: { allow: boolean; allowRestOfTurn?: boolean; reason?: string }): void {
    const p = this.pendingTools.get(toolUseId);
    if (!p) return;
    this.pendingTools.delete(toolUseId);
    if (decision.allow && decision.allowRestOfTurn) {
      this.approveAllForTurn.add(p.name);
    }
    // On deny, prefer the user's typed reason (so the agent can redirect)
    // and fall back to the canned message. The reason is already plumbed
    // through to the SDK via the canUseTool resolve → adapter permission msg.
    const denyReason = (decision.reason && decision.reason.trim())
      ? decision.reason.trim()
      : '用户在手机端拒绝了这个工具调用。';
    p.resolve({
      allow: decision.allow,
      reason: decision.allow ? undefined : denyReason,
    });
  }

  async interrupt(): Promise<void> {
    if (this.active) {
      try { await this.active.interrupt(); } catch { /* ignore */ }
    }
  }
}
