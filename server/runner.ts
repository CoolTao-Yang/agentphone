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
} from '../shared/types.ts';
import type {
  Agent,
  AgentTurn,
  CanUseToolFn,
} from './agents/types.ts';

// Everything that flows out of the runner. We unify under one shape so the
// replay buffer is a flat list. tool_request is an AgentEvent kind too — the
// distinction from 'pending vs resolved' is recovered by whether a matching
// tool_decision follows it in the stream.
export type RunnerEmit =
  | { kind: 'agent_event'; event: AgentEvent }
  | { kind: 'turn_done' }
  | { kind: 'error'; message: string };

export type RunnerListener = (emit: RunnerEmit) => void;

export class TurnRunner {
  private agent: Agent;

  private active: AgentTurn | null = null;
  private currentTurnId: string | null = null;
  private startedAtMs = 0;

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
   *  a new turn starts. */
  activeState(): ActiveTurnState | null {
    if (!this.currentTurnId) return null;
    const events: AgentEvent[] = [];
    for (const e of this.buffer) {
      if (e.kind === 'agent_event') events.push(e.event);
    }
    if (events.length === 0) return null;
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
  start(opts: { prompt: string; images?: import('../shared/types.ts').ImageAttachment[]; cwd: string; sessionId: string | null }): string {
    if (this.active) throw new Error('上一个对话还在进行');

    this.buffer = [];
    this.pendingTools.clear();
    this.approveAllForTurn.clear();
    this.startedAtMs = Date.now();

    const canUseTool: CanUseToolFn = async (toolName, input) => {
      const toolUseId = randomUUID();

      if (this.approveAllForTurn.has(toolName)) {
        this.record({
          kind: 'agent_event',
          event: { kind: 'tool_request', toolUseId, toolName, input, autoApproved: true },
        });
        this.record({
          kind: 'agent_event',
          event: { kind: 'tool_decision', toolUseId, allowed: true },
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
        });
      });
    };

    const turn = this.agent.startTurn({
      prompt: opts.prompt,
      images: opts.images,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      canUseTool,
    });

    this.active = turn;
    this.currentTurnId = turn.turnId;

    // Drive the iterator in the background — independent of any WS.
    (async () => {
      try {
        for await (const event of turn.iterate()) {
          this.record({ kind: 'agent_event', event });
        }
        this.record({ kind: 'turn_done' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.record({ kind: 'error', message: msg });
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
  respondToTool(toolUseId: string, decision: { allow: boolean; allowRestOfTurn?: boolean }): void {
    const p = this.pendingTools.get(toolUseId);
    if (!p) return;
    this.pendingTools.delete(toolUseId);
    if (decision.allow && decision.allowRestOfTurn) {
      this.approveAllForTurn.add(p.name);
    }
    p.resolve({
      allow: decision.allow,
      reason: decision.allow ? undefined : '用户在手机端拒绝了这个工具调用。',
    });
  }

  async interrupt(): Promise<void> {
    if (this.active) {
      try { await this.active.interrupt(); } catch { /* ignore */ }
    }
  }
}
