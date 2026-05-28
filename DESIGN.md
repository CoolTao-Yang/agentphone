# agentphone framework — design

A self-hosted, Tailscale-local, multi-harness AI agent control plane for phone + desktop.
Started as "phone PWA for cmax"; this doc plans the path to a generic framework.

Status: **planning** (Phase D). Implementation phases below.

---

## 1. Problem

Drive AI coding agents (Claude Code / cmax / Codex / future) from any device the user controls,
with conversation continuity across devices, **without** routing traffic through any external
relay (Anthropic / OpenAI cloud). Targets the case where the WSL desktop is the agent host and
the phone connects over Tailscale.

## 2. Non-negotiables (from requirements pass)

1. **Tailscale-local privacy** — conversation content stays in the user's tailnet. No third-party relay.
2. **cmax compatibility** — must coexist with existing cmax CLI workflow; don't force the user
   to give up multi-account / daemon / hooks / skills they invested in.
3. **WSL host** — Ubuntu-on-Windows is a first-class deployment.
4. **Chinese UI** — existing strings stay zh-CN by default.

Soft / phased:

5. Cross-device conversation continuity (phone ↔ CLI same thread).
6. Multi-harness adapter layer (claude SDK first; cmax-as-external second; codex stub third).
7. Server-restart-safe persistence of session metadata + links.
8. Native phone UI (paste image, button tool approval, push notifications).
9. APK + PWA parity.

Explicit out-of-scope (v1):

- Anthropic Remote Control's relay model (officially shipped 2026-02; we are the local-only alt).
- Replacing cmax in the user's terminal workflow.
- Browser-DOM observation patterns (CursorRemote-style).
- Multi-tenant / team-collab features (clay-style mates). Single-user, self-hosted.

## 3. Comparison of the candidate ecosystems

Surveyed 2026-05-28. Picked the patterns we borrow, named what we ship clean-room.

| Project              | Stars   | License    | Architecture                                    | What we take                              |
|----------------------|---------|------------|--------------------------------------------------|-------------------------------------------|
| Anthropic Remote Control | (1st-party) | Closed | Outbound HTTPS via Anthropic relay              | Concept only — wrong privacy model for us |
| hapi                 | 4.1k    | AGPL-3.0   | Hub (Socket.IO) + per-harness `*Local.ts` spawn + RpcRegistry + versioned updates | **Architecture inspiration** — no code copy |
| claudecodeui         | 11.4k   | AGPL-3.0   | filesystem-mirror webui                          | Architecture inspiration only             |
| clay                 | 295     | MIT        | Multi-user daemon, JSONL watcher, MCP adapters  | **Code borrow OK**: jsonl-watcher, cli-sessions |
| agent-of-empires     | 2.4k    | MIT        | Rust + tmux + git worktrees                      | Different model (terminal share). Not our path. |
| buckle42/claude-code-remote | (low) | n/a    | tmux + ttyd + Tailscale, zero code              | Concept only                              |
| claude-code-viewer   | 1.2k    | MIT        | Web viewer for ~/.claude/projects                | Concept only                              |

The two highest-star projects (hapi 4.1k, claudecodeui 11.4k) are both **AGPL-3.0**. We don't copy
their code. clay (MIT) provides utility functions we can lift with attribution.

## 4. Architecture

```
                                       ┌──────────────────────┐
                                       │   PWA / APK (phone)  │
                                       │   PWA / desktop      │
                                       └──────────┬───────────┘
                                                  │  WebSocket + REST
                                                  │  (Tailscale or LAN, ours)
                                                  │
                                 ┌────────────────▼──────────────────┐
                                 │       agentphone hub (Node)       │
                                 │                                   │
                                 │   ┌──────────────────────────┐    │
                                 │   │   HarnessRegistry        │    │
                                 │   │  name → HarnessAdapter   │    │
                                 │   └──────────┬───────────────┘    │
                                 │              │                    │
                                 │   ┌──────────┼───────────────┐    │
                                 │   ▼          ▼               ▼    │
                                 │  claude-sdk  cmax-external  codex │
                                 │  (own SDK)   (jsonl-watch)  (stub)│
                                 │              + status track       │
                                 │                                   │
                                 │   ┌──────────────────────────┐    │
                                 │   │   RpcRegistry            │    │
                                 │   │   adapter advertises ops │    │
                                 │   └──────────────────────────┘    │
                                 │                                   │
                                 │   ┌──────────────────────────┐    │
                                 │   │   SessionStore (JSON)    │    │
                                 │   │   + LinkStore (JSON)     │    │
                                 │   └──────────────────────────┘    │
                                 └────────────────┬──────────────────┘
                                                  │ filesystem read/spawn
                                  ┌───────────────┴────────────────┐
                                  │                                │
                       ┌──────────▼──────────┐         ┌───────────▼──────────┐
                       │  Agent SDK spawns   │         │  cmax CLI (external) │
                       │  claude.exe         │         │  user-controlled     │
                       │  (we own)           │         │  WE FOLLOW, don't    │
                       │                     │         │  drive (no race)     │
                       └─────────────────────┘         └──────────────────────┘
```

### 4.1 Harness adapter interface

Two modes a harness can be in: **owned** (we spawn it, we drive it) or **external** (someone
else owns it, we observe).

```ts
// server/harness/types.ts
export type HarnessKind = 'claude-sdk' | 'cmax-external' | 'codex' | 'gemini' | ...

export interface HarnessAdapter {
  kind: HarnessKind
  mode: 'owned' | 'external'

  // Discovery
  listSessions(): Promise<SessionSummary[]>
  getMessages(sessionId: string, limit?: number): Promise<SessionMessagesResponse | null>
  ownsSession(sessionId: string): Promise<boolean>

  // For 'owned' adapters only
  startTurn?(opts: StartTurnOptions): AgentTurn
  deleteSession?(sessionId: string): Promise<boolean>

  // For 'external' adapters only
  externalStatus?(sessionId: string): ExternalSessionStatus | null
  watchSession?(sessionId: string, onEvent: (e: AgentEvent) => void): () => void

  // RPC capability advertising
  rpcMethods(): string[]
  handleRpc?(method: string, params: unknown): Promise<unknown>
}
```

### 4.2 RpcRegistry (50 lines, inspired by hapi)

```ts
class RpcRegistry {
  private methodToAdapter = new Map<string, HarnessAdapter>()

  register(adapter: HarnessAdapter) {
    for (const m of adapter.rpcMethods()) {
      this.methodToAdapter.set(m, adapter)
    }
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const adapter = this.methodToAdapter.get(method)
    if (!adapter || !adapter.handleRpc) throw new Error(`no handler for ${method}`)
    return adapter.handleRpc(method, params)
  }
}
```

### 4.3 cmax-external adapter

This is the v18 follow-mode logic refactored into the adapter shape:

```ts
class CmaxExternalAdapter implements HarnessAdapter {
  kind = 'cmax-external' as const
  mode = 'external' as const

  // Reads ~/.claude-accounts/*/sessions/*.json (existing external-sessions.ts)
  externalStatus(sid) { return externalTracker.get(sid) }

  // jsonl watcher (borrow clay/lib/claude-jsonl-watcher.js, attributed)
  watchSession(sid, onEvent) {
    return startJsonlWatcher(findJsonlPath(sid), {
      onAssistantText: (text) => onEvent({ kind:'assistant_text', text }),
      onToolUse: (use) => onEvent({ kind:'tool_request', ...use }),
      onTurnEnd: () => onEvent({ kind:'turn_done' }),
    })
  }

  rpcMethods() { return [] }  // read-only, no RPC
}
```

### 4.4 claude-sdk adapter

Just the existing `server/agents/claude.ts` renamed and conforming to the new interface.
No functional change — refactor only.

### 4.5 LinkStore (new)

Persists phone-owned session ↔ external session relationships, so the **one-way mirror feature**
(originally proposed in option C) can work across server restarts.

```ts
// server/store/links.ts — JSON file, simple Map<phoneSid, cmaxSid>
interface LinkStore {
  link(phoneSid: string, externalSid: string): Promise<void>
  unlink(phoneSid: string): Promise<void>
  externalFor(phoneSid: string): string | null
  phonesFor(externalSid: string): string[]
}
```

When the phone-owned session emits `turn_done`, the runner calls into `LinkStore` to find any
linked external session and appends a `type: system, subtype: phone-mirror` entry to its jsonl.

## 5. Protocol delta

Additions to `shared/types.ts`:

```ts
// New ClientMessage variants
| { type: 'set_link'; phoneSessionId: string; externalSessionId: string | null }
| { type: 'rpc_call'; id: string; method: string; params: unknown }

// New ServerMessage variants
| { type: 'rpc_response'; id: string; result?: unknown; error?: string }
| { type: 'session_versioned_update'; sessionId: string; version: number; patch: Partial<SessionMetadata> }

// Add to SessionSummary
harness: HarnessKind        // which adapter owns it
linkedExternalSid?: string  // present if phone-owned and mirrored
```

## 6. Migration plan (concrete phases)

### Phase 1 — Refactor without behavior change (1-2 days)
- [ ] Create `server/harness/` dir tree
- [ ] Move existing claude SDK code into `server/harness/claude-sdk/adapter.ts`
- [ ] Define `HarnessAdapter` interface; make existing code conform
- [ ] Move `server/external-sessions.ts` into `server/harness/cmax-external/tracker.ts`
- [ ] Refactor `server/ws.ts` to dispatch via `HarnessRegistry` instead of direct `defaultAgent()`
- [ ] All existing tests should still pass; no observable client change
- [ ] **Commit: "refactor: extract HarnessAdapter layer"**

### Phase 2 — Borrow clay's jsonl watcher (1 day)
- [ ] Copy `clay/lib/claude-jsonl-watcher.js` into `server/harness/cmax-external/jsonl-watcher.ts`
  with port to TS + attribution header (MIT)
- [ ] Replace our current "poll-every-4s" follow-mode with event-driven watcher
- [ ] Wire `CmaxExternalAdapter.watchSession()` to push agent events live to WS
- [ ] Verify follow mode shows live updates without polling
- [ ] **Commit: "feat(follow-mode): replace 4s poll with jsonl-tail event watcher"**

### Phase 3 — LinkStore + one-way mirror (1 day)
- [ ] `server/store/links.ts` JSON-backed map
- [ ] WS `set_link` handler
- [ ] Client: on "+ 新建" from follow-mode banner, auto-call `set_link`
- [ ] On runner `turn_done` for phone-owned linked session, append `type: system, subtype: phone-mirror`
  entry to external jsonl
- [ ] CLI display: cmax CLI naturally renders system entries
- [ ] Header badge: "📎 → cmax/abc1234"
- [ ] **Commit: "feat(linking): one-way phone→cmax session mirror"**

### Phase 4 — RpcRegistry + versioned updates (1-2 days)
- [ ] Strip hardcoded WS message handlers, route through RpcRegistry
- [ ] Add `expectedVersion` to settings updates
- [ ] Server returns `version-mismatch` on stale write; client refetches
- [ ] **Commit: "refactor(protocol): RpcRegistry + versioned updates"**

### Phase 5 — Codex stub adapter (1 day, validates the framework)
- [ ] `server/harness/codex/adapter.ts` (owned mode)
- [ ] `spawn('codex', ['resume', sessionId, '--model', ...])` style launcher
- [ ] List sessions from codex's own filesystem layout
- [ ] Goal: prove the abstraction works with a second harness
- [ ] **Commit: "feat(harness): codex adapter (experimental)"**

### Later (no commit promised yet)
- SQLite persistence (only if JSON store hits scale issues)
- Web Push (we have SW; just need VAPID keys)
- Bidirectional sync (when one-way mirror proves insufficient)
- agentphone-cli replacement for cmax (long term)

## 7. Concrete repo layout after Phase 1-3

```
agentphone/
├── server/
│   ├── main.ts                       — boot, mount routes
│   ├── ws.ts                         — WS layer (slimmer, dispatches via registry)
│   ├── runner.ts                     — TurnRunner (per adapter instance)
│   ├── sessions.ts                   — REST API
│   ├── harness/
│   │   ├── registry.ts               — HarnessRegistry, RpcRegistry
│   │   ├── types.ts                  — HarnessAdapter interface
│   │   ├── claude-sdk/
│   │   │   ├── adapter.ts            — was agents/claude.ts
│   │   │   └── jsonl.ts              — was agents/claude.ts session list
│   │   ├── cmax-external/
│   │   │   ├── adapter.ts            — wraps tracker + watcher
│   │   │   ├── tracker.ts            — was external-sessions.ts
│   │   │   └── jsonl-watcher.ts      — clay-derived (MIT attribution)
│   │   └── codex/
│   │       └── adapter.ts            — stub
│   └── store/
│       ├── labels.ts                 — was in sessions.ts
│       └── links.ts                  — new
├── shared/types.ts                   — extended protocol
├── static/                           — PWA unchanged
└── DESIGN.md                         — this file
```

## 8. License & attribution

- agentphone stays **MIT**.
- Files derived from clay (MIT) get a header:
  ```ts
  // Derived from https://github.com/chadbyte/clay/blob/main/lib/claude-jsonl-watcher.js
  // Original copyright (c) 2026 Chad — MIT license
  // Modifications (c) 2026 Zetao Yang — MIT
  ```
- Architecture inspired by hapi (AGPL-3.0). No code copied. We just learned the shape.

## 9. Open questions

- (a) Should `LinkStore` support N:M (multiple phone sessions per external)? Probably not in v1.
- (b) Mirror format: full text dump vs structured `phone-mirror` system entry vs both?
  Current plan: structured entry with `content: { phoneSessionId, userPrompt, assistantText }`,
  cmax displays its `content` field naturally.
- (c) cmax CLI heartbeat is slow (3-min idle update). Do we trust `/proc` liveness + ignore
  `updatedAt`? Current external-sessions.ts already does this.
- (d) For Phase 5 codex, do we need a separate jsonl-watcher or does codex have a similar format?
  TBD when we get there.

---

Plan owner: zetao2100@gmail.com — agentphone repo.
Last updated: 2026-05-29.
