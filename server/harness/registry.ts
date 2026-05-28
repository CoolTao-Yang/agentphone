// HarnessRegistry — single place to wire concrete HarnessAdapter implementations.
//
// Adding a new harness:
//   1. Implement HarnessAdapter in server/harness/<name>/adapter.ts
//   2. Append to the `harnesses` array below
//   3. Nothing else (ws.ts, sessions.ts, runner.ts) needs to change
//
// RpcRegistry (pattern borrowed-by-shape from hapi/hub/src/socket/rpcRegistry.ts;
// no code copied — just the idea: adapter advertises its methods, registry
// routes by method name) lets adapters expose ops to the wire without ws.ts
// hardcoding them.

import { ClaudeSdkAdapter } from './claude-sdk/adapter.ts';
import { CodexAdapter } from './codex/adapter.ts';
import { externalSessions } from './cmax-external/tracker.ts';
import type { HarnessAdapter, HarnessKind, AgentKind } from './types.ts';

// ── Owned adapters (we spawn agent processes) ─────────────────
export const harnesses: HarnessAdapter[] = [
  new ClaudeSdkAdapter(),
  // CodexAdapter is a stub — listSessions returns [] until codex is
  // installed AND we wire spawn('codex', ...) in startTurn. Including it
  // here exercises the registry path so future PRs adding real codex
  // support only need to fill in adapter.ts.
  new CodexAdapter(),
  // new CursorAdapter(),
];

// ── External adapters (we follow but never drive) ─────────────
// cmax-external isn't a full HarnessAdapter yet; tracker singleton handles
// the read-only status surface directly. Phase 2 will wrap it as a proper
// HarnessAdapter so it shows up in sessions list as `mode: 'external'`.
export { externalSessions };

// ── Lookups ───────────────────────────────────────────────────
export function getHarnessByKind(kind: HarnessKind): HarnessAdapter | undefined {
  return harnesses.find((h) => h.harnessKind === kind);
}

export function getHarnessByAgent(agentKind: AgentKind): HarnessAdapter | undefined {
  return harnesses.find((h) => h.agentKind === agentKind);
}

export function defaultHarness(): HarnessAdapter {
  return harnesses[0];
}

export async function ownerOfSession(sessionId: string): Promise<HarnessAdapter | undefined> {
  for (const h of harnesses) {
    if (await h.ownsSession(sessionId)) return h;
  }
  return undefined;
}

// ── Back-compat aliases — ws.ts / sessions.ts / runner.ts still use these names
//    while Phase 1 settles. They forward to the new HarnessRegistry surface.
export const agents = harnesses;
export const defaultAgent = defaultHarness;
export function getAgent(kind: AgentKind): HarnessAdapter | undefined {
  return getHarnessByAgent(kind);
}

// ── RpcRegistry ──────────────────────────────────────────────
// Will be populated by Phase 4. Adapters call `rpcMethods()` on register.
// Hub looks up `method → adapter` then calls `adapter.handleRpc(method, params)`.
class RpcRegistry {
  private methodToAdapter = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    if (!adapter.rpcMethods) return;
    for (const method of adapter.rpcMethods()) {
      this.methodToAdapter.set(method, adapter);
    }
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const adapter = this.methodToAdapter.get(method);
    if (!adapter?.handleRpc) {
      throw new Error(`no handler registered for rpc method: ${method}`);
    }
    return adapter.handleRpc(method, params);
  }

  methods(): string[] {
    return Array.from(this.methodToAdapter.keys());
  }
}

export const rpcRegistry = new RpcRegistry();
for (const h of harnesses) rpcRegistry.register(h);
