# Reference repos — design inspiration for agentphone

These are third-party repos cloned into `reference/` (gitignored — not part of agentphone,
just local reading material). This file IS tracked: it's the curated comparison + the list
of borrowable ideas. Surveyed via a fan-out workflow on 2026-05-29 (10 search angles → gh-api
verified → relevance-scored → synthesized). 67 candidates discovered, 50 verified real, 40
clone-worthy; the 13 best (diverse, highest-relevance) were cloned below, plus the original 6.

How to use: when implementing a TODO from `STATE.md`, grep the relevant repo here first —
each entry lists exactly what to steal. Mind the licenses (NOASSERTION / unknown = read-only,
don't lift code).

---

## The original 6 (reviewed during DESIGN.md, 2026-05-28)

| repo | ★ | lang | license | what it taught us |
|---|---|---|---|---|
| **hapi** (slopus precursor era) | 4.1k | TS | AGPL-3.0 | Hub + Socket.IO + SSE + RpcRegistry; per-harness `*Local.ts` spawn pattern. **Architecture inspiration for our HarnessAdapter** (no code copied — AGPL). |
| **claudecodeui** | 11.4k | TS | AGPL-3.0 | filesystem-mirror webui; does NOT solve concurrent-driver race. Inspiration only. |
| **clay** | 295 | JS | MIT | `claude-jsonl-watcher.js` (we ported it, MIT-attributed) + `cli-sessions.js` jsonl header parser. Multi-user "mates". |
| **claude-code-viewer** | 1.2k | TS | MIT | read-only transcript viewer. |
| **agent-of-empires** | 2.4k | Rust | MIT | tmux + git-worktree isolation (a different model — isolate instead of share). |
| **claude-code-remote** | — | shell | — | tmux + ttyd + Tailscale zero-code approach (concept). |

Full original analysis: see `DESIGN.md` §3.

---

## agentphone reference-repo survey — ranked additions (beyond the 6 already reviewed)

Grounded in the actual codebase (`STATE.md`, `DESIGN.md`): agentphone already has the HarnessAdapter trichotomy (owned/external/stub), jsonl-tail follow-mode, inject/fork-with-history/merge bridge, CRDT-style versioned settings, Web Push on `turn_done`, OTA APK, and native voice **input**. Its self-imposed non-negotiable is **Tailscale-local, no external relay** — so hosted-only sync infra is disqualified, and self-hosted patterns are preferred. Selections below target its declared gaps: codex real adapter, remote tool-approval, rewind, richer push semantics, reconnect resilience, and multi-harness JSONL normalization.

### Tier S — direct product siblings (clone all)

**slopus/happy** — 21,332★ · TypeScript · MIT · mobile-control
- Borrow: (1) cryptographic public-key auth bootstrapped by a **QR the CLI displays** for phone pairing — cleaner than agentphone's token-in-QR. (2) **Device-handoff with reclaim-by-keypress**: CLI restarts session in remote mode for the phone; any local keypress instantly reclaims — a more polished bidirectional model than inject/fork/merge. (3) **Client-side E2E encryption** so even an untrusted relay can't decrypt — would let agentphone safely escape the Tailscale-trust assumption. (4) Push specifically on *permission-needed / error*, not just turn-complete.
- Verdict: The single closest peer; mine it first for validated UX and the 4-package decomposition (cli/agent/app/server).

**K9i-0/ccpocket** — 798★ · Dart/Flutter · MIT · mobile-control (pushed today)
- Borrow: (1) **stream-json bidirectional transport** (`claude --input-format stream-json --output-format stream-json --include-partial-messages`) as an SDK-independent adapter variant — cleaner than tailing JSONL. (2) **Permission/approval round-trip over WS** (`permission_request` → phone approve/deny → inject `tool_result`) — agentphone has *no remote approval gate*; this is high-value. (3) **Rewind** via `resumeSessionAt:<uuid>` + `enableFileCheckpointing` + `rewindFiles(dryRun)` to roll conversation AND filesystem back — agentphone has fork but no rewind. Plus offline message queuing with stream-gap replay on reconnect.
- Verdict: Almost the same product, further ahead on approval/rewind/teams. High borrow value despite Dart.

### Tier A — strong feature overlap (clone)

**saadnvd1/agent-os** — 146★ · TypeScript · MIT · multi-harness
- Borrow: (1) **PTY status-detector** inferring running/waiting-needs-attention/idle-acknowledged/dead with an "acknowledged" flag so the phone only buzzes on *unseen* waiting states — gives agentphone a principled WHEN-to-push signal. (2) **Conductor/worker MCP orchestration** with per-worker worktree isolation. (3) Event-typed notification prefs `{waiting,error,completed}` (completed off-by-default) — drop straight into the CRDT settings layer.
- Verdict: Same niche (mobile-first, self-hosted, Tailscale, multi-harness, PWA) with patterns agentphone lacks. Low stars but real code.

**mixpeek/amux** — 206★ · HTML/JS · NOASSERTION · multi-harness
- Borrow: (1) **Non-invasive ANSI-stripped scrollback parsing** to derive state with zero hooks — a 4th adapter style needing no jsonl. (2) **Self-healing watchdog**: auto `/compact` on context depletion, fleet-wide rate-limit coordination, restart-and-replay — agentphone currently fails silently here. (3) **State-aware parsing that distinguishes human intervention from auto-recovery** — directly relevant to the documented two-claude.exe race in the bidirectional bridge.
- Verdict: Rich orchestration + the rate-limit/compaction self-healing agentphone explicitly lacks. Watch the NOASSERTION license for code lifting (reference-only).

**Ataraxy-Labs/opensessions** — 1,074★ · Rust · unknown license · multi-harness
- Borrow: (1) **Per-harness watcher source map** (Amp JSON / Claude JSONL / Codex JSONL resolved by `turn_context.cwd` / OpenCode SQLite polling) — better source-resolution than agentphone's 3 adapters. (2) **Per-thread unseen markers with 3 terminal tones** (done/error/interrupted) clearing on view — more nuanced than one "turn done" push. (3) **Zero-dep `curl` HTTP ingress** (`/set-status`, `/notify`) so Claude Code Stop/Notification hooks push explicit status instead of inference. License unknown → reference-only.
- Verdict: The desktop-sidebar mirror of agentphone's follow-mode; best per-adapter completion-detection reference.

**Emanuele-web04/remodex** — 3,133★ · Swift · Apache-2.0 · terminal-bridge
- Borrow: (1) **JSON-RPC-over-WS bridge to `codex app-server`** via stdin/stdout — the exact protocol agentphone's *codex stub* (P1 TODO) should speak instead of tailing JSONL. (2) **QR crypto pairing** carrying {URL, sessionId, bridge identity key} + trusted-device store. (3) **E2E envelope** (X25519 + HKDF-SHA256 + AES-256-GCM) and reconnect with exponential backoff + bounded outbound buffer. (4) `launchd` keep-alive (agentphone uses systemd — parity).
- Verdict: Same problem space, local-first. Swift so no code reuse, but the codex JSON-RPC shape and crypto pairing are concrete and load-bearing.

**generalaction/emdash** — 4,680★ · TypeScript · Apache-2.0 · multi-harness
- Borrow: (1) **Metadata-driven harness registry** — a flat `AgentProviderDefinition` record (sessionIdFlag, resumeFlag, autoApproveFlag, useKeystrokeInjection, supportsHooks…) so adding a harness = one data entry, not a class. Consider a hybrid backing agentphone's `HarnessAdapter` interface with this registry. (2) **Per-provider terminal-output classifiers** (4KB sliding window + stripAnsi + regex) emitting `{type:'notification'|'stop'|'error'}` — useful for the `cmax-external` follow adapter's push trigger. (3) **Tokenized localhost hook-server** (`x-emdash-token`, keyed by pty-id, 1MB cap) auto-wired into each worktree's `.claude/settings.local.json`.
- Verdict: Cleanest declarative-registry reference; TS so directly portable. No mobile/PWA, where agentphone is already ahead.

### Tier B — focused, high-quality single-concern references (clone)

**ekristen/guppi** — 10★ · Go · MIT · terminal-bridge
- Borrow: (1) **Multi-layer agent-state detection** (hooks primary + `/proc` scan every 5s + 10s silence monitor + prompt parser for y/n & numbered options) — more robust than jsonl-tailing for the codex stub. (2) **Reconciler** sweep clearing stale waiting/active states across many sessions. (3) Attention notifications broadcast via a WS hub decoupled from any single tab.
- Verdict: Tiny stars but genuinely the best state-detection design here. The low star count is *not* star-farming — it's an obscure but real, well-factored Go codebase. Reference-only for Go.

**wbopan/cui** — 1,153★ · TypeScript · Apache-2.0 · multi-harness (archived, code intact)
- Borrow: (1) **Interactive permission approval via injected MCP permission handler** — tool call → pending request → push → blocks until phone approves/denies (`PermissionDialog`, `permission-tracker.ts`). Complements ccpocket's approval pattern with a Claude-Code-native MCP approach. (2) **Web-push reference** (web-push lib, VAPID auto-gen persisted, better-sqlite3 subs, dead-sub pruning on 404/410) — a more complete version of agentphone's push. (3) `useMultipleStreams.ts` multi-session state machine with backoff reconnect.
- Verdict: Archived but the permission-over-MCP and web-push code are clean, directly-comparable TS. High reference value.

**Dicklesworthstone/cross_agent_session_resumer** — 82★ · Rust · NOASSERTION · multi-harness
- Borrow: (1) **CanonicalSession IR + Provider trait** (detect/read/write/resume_command) normalizing Claude/Codex/Gemini/Cursor — the `resume_command()` hook maps onto merge-back-to-CLI. (2) **Read-back verification** after writing a forked/merged session (re-parse to catch writer bugs) + **atomic write with .bak rollback** — a cheap safety net for agentphone's merge bridge, which currently mutates CLI jsonl with no verification. (3) Concrete on-disk format map for Codex/Gemini/Cursor.
- Verdict: Best reference for the *correctness* of agentphone's fork/merge file mutations. Low stars, real production code, license NOASSERTION → reference-only.

### Tier C — schema / infrastructure foundations (clone)

**daaain/claude-code-log** — 1,057★ · Python · MIT · jsonl-tooling
- Borrow: (1) **Complete discriminated-union TranscriptEntry model** (User/Assistant/System/Summary/QueueOperation/Attachment/Passthrough, each with parentUuid/uuid/isSidechain/isMeta) to port to TS — hardens the follow-mode tailer against malformed lines. (2) **PassthroughTranscriptEntry** keeps non-rendered entries in the DAG to preserve parentUuid continuity (prevents broken links when tailing live). (3) A **golden-file fixture corpus** (one jsonl per message/tool/sidechain variant) — a portable test suite for agentphone's parser.
- Verdict: The single most authoritative model of the JSONL format agentphone depends on. Batch HTML (no server) so schema/fixtures are the value, not the runtime.

**yjs/yjs** — 21,923★ · JavaScript · MIT · sync-crdt
- Borrow: (1) **State-vector differential sync** — replace agentphone's likely full-settings-blob pushes with O(delta) sync so reconnecting phones fetch only changes. (2) **Commutative + idempotent updates** — exactly the guarantee the CRDT settings need to survive flaky reconnects + duplicate WS delivery, with no conflict-resolution code. (3) **Provider layering** (WS relay + offline IndexedDB merge-on-reconnect) and the **awareness/presence** protocol (which client is driving phone vs CLI).
- Verdict: Production-grade, self-hostable (unlike Liveblocks, which is disqualified by the no-relay rule), MIT. The reference for replacing the hand-rolled CRDT.

### Notable repos NOT cloned (and why)
- **Liveblocks** (4.6k★): sync engine is a proprietary *hosted cloud* — directly conflicts with the no-external-relay non-negotiable. Concept-only; not adoptable infra.
- **baryhuang/claude-code-by-agents** (874★, rel 5), **QuivrHQ/247-claude-code-remote** (63★, rel 5, license-less, headline features aspirational/not implemented): too redundant or thin.
- **bradAGI/awesome-cli-coding-agents** (465★): docs-only awesome-list, no code. Useful as a *lead generator* (points to Untether, CLITrigger, EchoCoding) but nothing to clone.
- **wshobson/agents** (36k★): great adapter-ABC reference but it's *build-time codegen*, not live agent control — lower priority than the runtime siblings above; skipped to keep the set focused/diverse.
- **open-webui / lobe-chat / LibreChat** (big chat-box UIs): excellent streaming-render and PWA references but they're chat products, not agent-control planes; agentphone already has streaming render and PWA. Skipped to avoid category over-weighting (chose `cui` as the leaner PWA+Claude-CLI representative).
- **automerge / tinybase / jazz / verdant / meridian / sqlite-sync** (CRDT family): all valid, but `yjs` is the highest-leverage single pick (largest ecosystem, MIT, JS-native for the Node server + PWA). One CRDT clone is enough for diversity.
- **pipecat / novu / FluidMarkdown / langchain agent-chat-ui / ChatLLM-Web**: tangential (voice-pipeline / enterprise-notif / native-markdown / LangGraph-only / browser-LLM); relevance ≤5 or solving problems agentphone already has. Excluded.
- **Cap-go/capacitor-updater** (767★, rel 7): genuinely upgrades agentphone's naive OTA (notifyAppReady failsafe rollback, delta updates, manual self-hosted mode). A strong *honorable mention* — it's the one I'd add at slot 13 if the cap weren't ~12. Worth pulling later specifically for the OTA hardening.

### Biggest gaps in agentphone these repos expose
1. **No remote tool-approval gate.** agentphone can inject but can't approve/deny a Bash/Edit/MCP tool call from the phone. ccpocket (WS approval round-trip), cui (MCP permission handler), and emdash (classifiers) all solve this — it's the single highest-value missing mobile-control feature.
2. **Codex stub still throws.** remodex (codex app-server JSON-RPC), happy (CLI-wrapper bridge), and ccpocket (stream-json transport) give three concrete, well-typed ways to make codex real — better than the planned JSONL-tail approach.
3. **No rewind / file checkpointing.** Fork-with-history exists, but no way to roll conversation+filesystem back to a chosen message. ccpocket's `resumeSessionAt` + `rewindFiles(dryRun)` is fully specified.
4. **Push is binary ("turn done").** No semantic classification (needs-input / error / plan-ready) and no debounce. opensessions (3 terminal tones), agent-os (acknowledged-flag), guppi (multi-layer detection), and 777genius's turn-classification state machine all model this richly.
5. **No self-healing on context-limit / rate-limit.** amux auto-`/compact`s and coordinates fleet-wide rate-limit resumption; agentphone fails silently. Pair with a push instead.
6. **Merge/fork mutates CLI jsonl with no verification.** cross_agent_session_resumer's read-back verification + atomic write+rollback would prevent corrupting a live CLI session.
7. **Hand-rolled CRDT + likely full-blob sync.** yjs offers delta sync, idempotent merge, offline-then-reconnect, and presence — all self-hostable.
8. **Parser robustness.** No discriminated-union schema or golden-file fixtures; claude-code-log provides both, hardening the tailer against malformed/sidechain/passthrough lines.
9. **OTA has no health gate / rollback.** A bad CI build could brick the hand-off; capacitor-updater's notifyAppReady failsafe is the fix (honorable mention to clone next).