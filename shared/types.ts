// Shared protocol types — used by both server and browser.

// ────────────────────────────────────────────────────────────────
// WebSocket: client → server
// ────────────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'prompt'; text: string; images?: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'select_session'; sessionId: string | null; cwd?: string }
  | { type: 'tool_response'; toolUseId: string; decision: 'allow' | 'deny'; allowRestOfTurn?: boolean };

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
    }
  | { type: 'unauthorized' }
  | { type: 'session_set'; sessionId: string | null; cwd: string }
  | { type: 'agent_event'; event: AgentEvent }
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
};

export type ActiveTurnState = {
  turnId: string;
  startedAt: number;
  events: AgentEvent[]; // includes tool_request entries; pending = tool_request not yet followed by tool_decision
  done: boolean;        // true if the turn has already finished and the buffer is being kept around for replay
};

export type RecentCwdsResponse = { cwds: string[] };
export type UpdateSessionRequest = { name?: string | null };

// History messages returned from GET /api/sessions/:id/messages — already
// stripped of system-only wrappers (<local-command-caveat>, <command-name> …)
// and de-noised for direct rendering.
export type HistoryMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { role: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export type SessionMessagesResponse = {
  sessionId: string;
  cwd: string;
  messages: HistoryMessage[];
  total: number;       // total events in the jsonl (so client knows there's more)
};
