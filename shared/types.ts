// Shared protocol types — used by both server and browser.

// ────────────────────────────────────────────────────────────────
// WebSocket: client → server
// ────────────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'prompt'; text: string }
  | { type: 'interrupt' }
  | { type: 'select_session'; sessionId: string | null; cwd?: string }
  | { type: 'tool_response'; toolUseId: string; decision: 'allow' | 'deny'; allowRestOfTurn?: boolean };

// ────────────────────────────────────────────────────────────────
// WebSocket: server → client
// ────────────────────────────────────────────────────────────────
export type ServerMessage =
  | { type: 'connected'; defaultCwd: string; currentCwd: string; currentSessionId: string | null }
  | { type: 'unauthorized' }
  | { type: 'session_set'; sessionId: string | null; cwd: string }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'tool_request'; toolUseId: string; toolName: string; input: unknown; autoApproved?: boolean }
  | { type: 'turn_done' }
  | { type: 'error'; message: string };

// Normalized agent events. Server flattens SDK messages to these so the
// frontend never has to look at raw Anthropic Beta event shapes.
export type AgentEvent =
  | { kind: 'session_init'; sessionId: string }
  | { kind: 'assistant_block_start'; messageId: string; blockIndex: number; blockType: 'text' | 'tool_use' | 'thinking' }
  | { kind: 'text_delta'; messageId: string; blockIndex: number; delta: string }
  | { kind: 'thinking_delta'; messageId: string; blockIndex: number; delta: string }
  | { kind: 'assistant_block_end'; messageId: string; blockIndex: number }
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
};

export type RecentCwdsResponse = { cwds: string[] };
export type UpdateSessionRequest = { name?: string | null };
