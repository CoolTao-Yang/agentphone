// HarnessAdapter: the unifying interface for "thing that can drive an AI coding
// agent and/or expose its conversation state".
//
// Two modes:
//   - 'owned'    : we spawn it ourselves (claude.exe via Agent SDK, codex, ...)
//                  and have full read/write control over its sessions.
//   - 'external' : another process (cmax CLI on the desktop, a bg job, ...)
//                  owns the session; we can read jsonl + status but must not
//                  spawn our own process or we race for the assistant write.
//
// v3 (this file) keeps backward compatibility with the old `Agent` name —
// runner.ts and the wire protocol can keep using `Agent`/`AgentKind` while
// internal code migrates to `HarnessAdapter`/`HarnessKind`.

import type {
  AgentEvent,
  EffortLevel,
  ExternalSessionStatus,
  ImageAttachment,
  SessionSummary,
  SessionMessagesResponse,
} from '../../shared/types.ts';

// Wire-protocol value (lives on SessionSummary.agent, never changes silently).
// Internally we may distinguish 'claude-sdk' vs 'cmax-external' both serving
// `agent: 'claude'`, but the wire stays narrow.
export type AgentKind = 'claude' | 'codex' | 'cursor';

// Internal-only finer-grained label, used to route HarnessRegistry lookups.
// Each adapter declares its own kind here; the wire `agent` field is derived.
export type HarnessKind =
  | 'claude-sdk'
  | 'cmax-external'
  | 'codex'
  | 'cursor';

export type HarnessMode = 'owned' | 'external';

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  // The harness's real tool-use id for this call, when available (e.g. the
  // Anthropic SDK's options.toolUseID). The runner uses it as the event id so
  // tool_request and tool_result share the same id and the client can fold the
  // result into the right card. Falls back to a generated id when absent.
  toolUseId?: string,
) => Promise<CanUseToolResult>;

export type CanUseToolResult =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { allow: false; reason?: string };

export type StartTurnOptions = {
  prompt: string;
  images?: ImageAttachment[];
  cwd: string;
  sessionId: string | null;
  effort?: EffortLevel;
  canUseTool: CanUseToolFn;
};

export interface AgentTurn {
  readonly turnId: string;
  iterate(): AsyncGenerator<AgentEvent, void>;
  interrupt(): Promise<void>;
}

export interface HarnessAdapter {
  /** Internal-only adapter label. */
  readonly harnessKind: HarnessKind;

  /** Wire-protocol agent value (SessionSummary.agent). */
  readonly agentKind: AgentKind;

  /** Whether we spawn the agent process ourselves ('owned') or read-only follow
   *  someone else's process ('external'). */
  readonly mode: HarnessMode;

  // ── Discovery (always available) ─────────────────────────────
  listSessions(): Promise<SessionSummary[]>;
  getSessionMessages(sessionId: string, limit: number): Promise<SessionMessagesResponse | null>;
  ownsSession(sessionId: string): Promise<boolean>;
  recentCwds(): Promise<string[]>;

  // ── 'owned' adapters: required ──────────────────────────────
  // Phase 1 only ships owned adapters, so both are mandatory. When Phase 2
  // adds the cmax-external read-only adapter we'll split into
  // OwnedHarnessAdapter (extends HarnessAdapter) carrying these, and the
  // base interface will mark them optional.
  startTurn(opts: StartTurnOptions): AgentTurn;
  deleteSession(sessionId: string): Promise<boolean>;

  // ── 'external' adapters only ─────────────────────────────────
  /** Current driver status for a session this adapter owns (mode==='external'). */
  externalStatus?(sessionId: string): ExternalSessionStatus | null;
  /** Subscribe to live events appended by the external driver. Returns unsub. */
  watchSession?(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;

  // ── RPC capability advertising (RpcRegistry pattern) ────────
  /** Methods this adapter can serve via the hub's RPC dispatcher. */
  rpcMethods?(): string[];
  /** Invoked by the registry when a client calls one of our rpcMethods. */
  handleRpc?(method: string, params: unknown): Promise<unknown>;
}

// ── Back-compat aliases ────────────────────────────────────────
// Older internals (runner.ts) import { Agent } from this module. Keep the name
// so we can refactor in small steps. Removing once all call sites migrate.
export type Agent = HarnessAdapter;
