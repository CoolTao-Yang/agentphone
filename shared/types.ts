// Shared protocol types — used by both server and browser.

// ────────────────────────────────────────────────────────────────
// WebSocket: client → server
// ────────────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'prompt'; text: string; images?: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'select_session'; sessionId: string | null; cwd?: string }
  | { type: 'tool_response'; toolUseId: string; decision: 'allow' | 'deny'; allowRestOfTurn?: boolean }
  | { type: 'set_settings'; autoApproveTools?: boolean; effort?: EffortLevel; perToolAuto?: Record<string, boolean> }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'ok'; message: string; ts?: number }
  | { type: 'pong'; ts: number }
  // Acknowledge that the user is OK driving a session that another end
  // (CLI / bg job) is also driving. Until takeover is sent, the server tells
  // the client `followMode:true` and rejects prompts.
  | { type: 'takeover'; sessionId: string };

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentSettings = {
  autoApproveTools: boolean;
  effort: EffortLevel;
  // Per-tool auto-approve rules: tool name → auto-allow. Wildcard '*' means
  // "all tools". autoApproveTools (above) is shorthand for `'*': true`.
  perToolAuto?: Record<string, boolean>;
};

// Base64 image data — `data` is the bare base64 (no "data:..." prefix).
export type ImageAttachment = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  // Optional: original filename, used only in history/preview.
  name?: string;
};

// ────────────────────────────────────────────────────────────────
// WebSocket: server → client
// ────────────────────────────────────────────────────────────────
export type ServerMessage =
  | {
      type: 'connected';
      defaultCwd: string;
      currentCwd: string;
      currentSessionId: string | null;
      claudeAccount: string;
      activeTurn: ActiveTurnState | null;
      settings: AgentSettings;
      // Whether the currently-selected session is being driven by an external
      // claude.exe (e.g. desktop CLI). When true, the client should render the
      // follow-mode banner and disable prompt input until the user accepts
      // the risk and sends a `takeover` message.
      external: ExternalSessionStatus | null;
    }
  | { type: 'settings'; settings: AgentSettings }
  | { type: 'ping'; ts: number }
  | { type: 'unauthorized' }
  | { type: 'session_set'; sessionId: string | null; cwd: string; external: ExternalSessionStatus | null }
  | { type: 'agent_event'; turnId: string; seq: number; event: AgentEvent }
  | { type: 'turn_done' }
  | { type: 'error'; message: string }
  // Status of an externally-driven session changed (busy↔idle, or appeared/
  // disappeared). The client uses this to flip the drawer dot and the header
  // banner without polling.
  | { type: 'external_status'; sessionId: string; external: ExternalSessionStatus | null };

export type ExternalSessionStatus = {
  pid: number;
  account: string;       // 'cmax' | 'cpro1' | …
  kind: string;          // 'interactive' | 'bg' | …
  status: 'idle' | 'busy';
};

// Normalized agent events. Server flattens SDK messages to these so the
// frontend never has to look at raw Anthropic Beta event shapes.
export type AgentEvent =
  | { kind: 'session_init'; sessionId: string }
  | { kind: 'assistant_block_start'; messageId: string; blockIndex: number; blockType: 'text' | 'tool_use' | 'thinking' }
  | { kind: 'text_delta'; messageId: string; blockIndex: number; delta: string }
  | { kind: 'thinking_delta'; messageId: string; blockIndex: number; delta: string }
  | { kind: 'assistant_block_end'; messageId: string; blockIndex: number }
  | { kind: 'tool_request'; toolUseId: string; toolName: string; input: unknown; autoApproved: boolean }
  | { kind: 'tool_decision'; toolUseId: string; allowed: boolean }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'result'; success: boolean; durationMs: number; turns: number; costUsd: number; isError: boolean };

// ────────────────────────────────────────────────────────────────
// REST
// ────────────────────────────────────────────────────────────────
export type SessionSummary = {
  sessionId: string;
  cwd: string;
  name: string | null;
  preview: string;
  lastUsed: number; // unix ms
  turns: number;
  agent: 'claude' | 'codex' | 'cursor';
  /** True if there is currently an active (in-flight) turn on this session
   *  — drawer renders a small pulse indicator. */
  running?: boolean;
  /** Set when the session is being driven by an external claude.exe (CLI,
   *  bg job, …). Drawer renders a 🟢 dot; selecting the session enters
   *  follow-mode. */
  external?: ExternalSessionStatus | null;
};

export type SeqEvent = {
  seq: number;
  event: AgentEvent;
};

export type ActiveTurnState = {
  turnId: string;
  startedAt: number;
  // Each event carries a monotonic seq number assigned by the server when
  // emitted. Client tracks the highest seq it has rendered; on reconnect
  // for the same turn it only appends events with seq > lastRenderedSeq
  // instead of full-replaying. Includes tool_request entries; "pending"
  // tool = tool_request not yet followed by tool_decision.
  events: SeqEvent[];
  done: boolean;
};

export type RecentCwdsResponse = { cwds: string[] };
export type UpdateSessionRequest = { name?: string | null };

// History messages returned from GET /api/sessions/:id/messages — already
// stripped of system-only wrappers (<local-command-caveat>, <command-name> …)
// and de-noised for direct rendering.
export type HistoryMessage =
  | { role: 'user'; text: string; images?: ImageAttachment[] }
  | { role: 'assistant'; text: string }
  | { role: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { role: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export type SessionMessagesResponse = {
  sessionId: string;
  cwd: string;
  messages: HistoryMessage[];
  total: number;       // total events in the jsonl (so client knows there's more)
};
