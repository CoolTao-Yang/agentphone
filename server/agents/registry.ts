// Single place where we wire concrete Agent implementations.
// Add new agents here (CodexAgent, CursorAgent, …) — nothing in ws.ts /
// sessions.ts / runner.ts needs to change.

import { ClaudeAgent } from './claude.ts';
import type { Agent, AgentKind } from './types.ts';

export const agents: Agent[] = [
  new ClaudeAgent(),
  // new CodexAgent(),
  // new CursorAgent(),
];

export function getAgent(kind: AgentKind): Agent | undefined {
  return agents.find((a) => a.kind === kind);
}

export function defaultAgent(): Agent {
  return agents[0];
}

export async function ownerOfSession(sessionId: string): Promise<Agent | undefined> {
  for (const a of agents) {
    if (await a.ownsSession(sessionId)) return a;
  }
  return undefined;
}
