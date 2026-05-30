// Shared protocol types — used by both server and browser.

// ────────────────────────────────────────────────────────────────
// WebSocket: client → server
// ────────────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'prompt'; text: string; images?: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'select_session'; sessionId: string | null; cwd?: string }
  // reason: optional free-text the user types when denying, fed back to the
  // agent so they can redirect it ("use ripgrep instead") instead of just
  // getting a canned rejection and having to wait out the turn.
  // updatedInput: the user edited the tool args before approving (#32). Server
  // merges only known-safe keys (command/file_path/content) over the original.
  | { type: 'tool_response'; toolUseId: string; decision: 'allow' | 'deny'; allowRestOfTurn?: boolean; reason?: string; updatedInput?: Record<string, unknown> }
  // CRDT-style optimistic-concurrency update: client passes expectedVersion
  // (the version it last saw). Server rejects with `settings_conflict` if a
  // different client has updated in the meantime, then the rejected client
  // can refetch + retry. If expectedVersion is missing the server applies
  // anyway (no-conflict legacy path).
  | {
      type: 'set_settings';
      expectedVersion?: number;
      autoApproveTools?: boolean;
      effort?: EffortLevel;
      perToolAuto?: Record<string, boolean>;
      // Model id to drive turns with (e.g. 'claude-opus-4-8'). Empty string or
      // null clears it → fall back to the account/SDK default model.
      model?: string | null;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'ok'; message: string; ts?: number }
  | { type: 'pong'; ts: number }
  // Acknowledge that the user is OK driving a session that another end
  // (CLI / bg job) is also driving. Until takeover is sent, the server tells
  // the client `followMode:true` and rejects prompts.
  | { type: 'takeover'; sessionId: string }
  // Clear a session's unread/attention marker — sent when the user views it.
  | { type: 'mark_seen'; sessionId: string }
  // Local usage telemetry (UX research). Content-free: name + coarse props
  // + the client's shell/form so we can compare mobile vs desktop habits.
  // Stored locally only (server/store/usage.ts), never sent anywhere.
  | { type: 'usage'; name: string; shell?: string; form?: string; props?: Record<string, unknown> }
  // β path: phone writes the text as a user message into an externally-owned
  // session's jsonl. cmax sees it as a queued user prompt — desktop user
  // presses Enter to actually trigger the response (or cmax auto-fires if
  // it's in an interactive prompt state).
  | { type: 'inject_to_external'; sessionId: string; text: string; images?: ImageAttachment[] }
  // α path: declare that a phone-owned session is "linked" to an external
  // CLI session, so each completed turn on the phone gets mirrored into
  // the external jsonl as a system entry. Pass null externalSessionId to
  // unlink.
  | { type: 'set_link'; phoneSessionId: string; externalSessionId: string | null }
  // α-plus path: walk the phone-owned session's whole jsonl and dump a
  // single condensed user message into the linked external session's
  // jsonl. cmax queues it; user presses Enter to let claude.exe pick up
  // B's context as A's next prompt. One-time merge — repeatable for
  // additional turns but not auto.
  | { type: 'merge_to_external'; phoneSessionId: string; externalSessionId: string }
  // Fork-with-history (the right way to "continue this conversation on
  // phone"): server reads A's jsonl, formats every user/assistant turn
  // into a system-context block, stashes it as a one-time prefix for
  // this connection's NEXT prompt. The new phone session B's first SDK
  // call sees the prefix + the user's actual text, so its claude.exe
  // starts out knowing what was discussed in A. Subsequent turns continue
  // naturally with B's own accumulating jsonl.
  //
  // cwd defaults to A's cwd if omitted — fork-with-history is "same
  // conversation, different driver", so different cwd would defeat the
  // purpose.
  | { type: 'fork_session'; externalSessionId: string; cwd?: string };

// 'ultracode' (= xhigh + dynamic workflow orchestration) is offered by newer
// Claude Code builds beyond 'max'. The installed SDK's own type and the CLI's
// supportedEffortLevels still list only the first five, but the CLI ACCEPTS
// 'ultracode' at runtime (verified: a turn with effort:'ultracode' succeeds),
// so we surface it. The adapter casts past the SDK's narrower type.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

// Model metadata for the dynamic model picker. A subset of the SDK's ModelInfo
// (server reads it from Query.supportedModels()). The client builds its model
// menu from this at runtime, so new models appear without a code change — and
// each model's supportedEffortLevels drives which effort levels the UI offers.
export type ModelInfo = {
  /** Model id passed to the SDK (e.g. 'claude-opus-4-8'). */
  value: string;
  /** Human label (e.g. 'Claude Opus 4.8'). */
  displayName: string;
  description?: string;
  /** False ⇒ this model ignores effort entirely (UI hides the effort chip). */
  supportsEffort?: boolean;
  /** Effort levels this model honors; UI restricts the effort menu to these. */
  supportedEffortLevels?: EffortLevel[];
};

export type ModelsResponse = { models: ModelInfo[] };

// Per-session "needs attention" signal for the drawer unread marker
// (UX-BACKLOG #9). needs_input = a tool is waiting for approval (most
// urgent); error = the turn failed; done = the turn finished. needs_input
// and error drive the app badge count; done is a subtle marker only.
export type AttentionKind = 'needs_input' | 'error' | 'done';

export type AgentSettings = {
  autoApproveTools: boolean;
  effort: EffortLevel;
  // Model id to drive turns with (e.g. 'claude-opus-4-8'). Undefined ⇒ use the
  // account/SDK default model. Global, like effort — shared across sessions.
  model?: string;
  // Per-tool auto-approve rules: tool name → auto-allow. Wildcard '*' means
  // "all tools". autoApproveTools (above) is shorthand for `'*': true`.
  perToolAuto?: Record<string, boolean>;
  // Monotonic version bump on every change. Clients pass the version they
  // last saw in set_settings.expectedVersion; on mismatch the server returns
  // settings_conflict so the client can rebase + retry.
  version: number;
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
  // Server rejected a set_settings because expectedVersion was stale; client
  // should adopt the included `current` AgentSettings and re-derive its UI
  // (no retry — user can re-issue the click if they really want).
  | { type: 'settings_conflict'; current: AgentSettings }
  | { type: 'ping'; ts: number }
  | { type: 'unauthorized' }
  | { type: 'session_set'; sessionId: string | null; cwd: string; external: ExternalSessionStatus | null }
  | { type: 'agent_event'; turnId: string; seq: number; event: AgentEvent }
  | { type: 'turn_done' }
  | { type: 'error'; message: string }
  // Status of an externally-driven session changed (busy↔idle, or appeared/
  // disappeared). The client uses this to flip the drawer dot and the header
  // banner without polling.
  | { type: 'external_status'; sessionId: string; external: ExternalSessionStatus | null }
  // Echo of the current link state for a phone-owned session. Server sends
  // after set_link or on initial select_session if a saved link exists.
  | { type: 'link_info'; phoneSessionId: string; externalSessionId: string | null }
  // A session's attention state changed (UX-BACKLOG #9). Broadcast to ALL
  // connected clients so every drawer updates its unread marker live, even
  // for sessions the client isn't currently subscribed to. null = cleared.
  | { type: 'attention'; sessionId: string; kind: AttentionKind | null }
  // Result of a merge_to_external: the condensed context block. The client can
  // show it with a copy button so the user pastes it as their next prompt — no
  // CLI `resume` needed (the block is also queued in the jsonl as a fallback).
  | { type: 'merge_result'; turns: number; text: string };

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
  | { kind: 'result'; success: boolean; durationMs: number; turns: number; costUsd: number; isError: boolean }
  // Emitted by the cmax-external jsonl-watcher when a NEW user message lands
  // in a session driven by another claude.exe (e.g. user typed in the CLI).
  // Follow-mode UI renders this as a regular user prompt so the phone sees
  // CLI input live without polling.
  | { kind: 'external_user_prompt'; text: string; images?: ImageAttachment[] };

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
  /** Unseen-activity marker for the drawer (UX-BACKLOG #9). */
  attention?: AttentionKind | null;
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
