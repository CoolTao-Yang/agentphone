// Agent abstraction. v3.1 ships only ClaudeAgent, but the interface is
// shaped to accept Codex / Cursor / other CLI-backed agents later without
// touching the WS or REST layer.
//
// Multi-agent considerations baked in:
//   • normalized AgentEvent (not Anthropic-specific Beta event shapes)
//   • normalized canUseTool: takes name+input, returns allow/deny + reason
//   • per-agent storage: each Agent knows where its own session files live
//   • SessionSummary.agent tags every listed session with its origin

import type {
  AgentEvent,
  ImageAttachment,
  SessionSummary,
  SessionMessagesResponse,
} from '../../shared/types.ts';

export type AgentKind = 'claude' | 'codex' | 'cursor';

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<CanUseToolResult>;

export type CanUseToolResult =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { allow: false; reason?: string };

export type StartTurnOptions = {
  prompt: string;
  images?: ImageAttachment[];
  cwd: string;
  sessionId: string | null;
  canUseTool: CanUseToolFn;
};

export interface AgentTurn {
  readonly turnId: string;
  iterate(): AsyncGenerator<AgentEvent, void>;
  interrupt(): Promise<void>;
}

export interface Agent {
  readonly kind: AgentKind;
  startTurn(opts: StartTurnOptions): AgentTurn;
  listSessions(): Promise<SessionSummary[]>;
  getSessionMessages(sessionId: string, limit: number): Promise<SessionMessagesResponse | null>;
  deleteSession(sessionId: string): Promise<boolean>;
  ownsSession(sessionId: string): Promise<boolean>;
  recentCwds(): Promise<string[]>;
}
