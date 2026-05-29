# agentphone — STATE

> Living memory of the project. Three sections: **现状 (current)**, **理想态 (ideal)**, **TODO**.
> Update this file whenever a milestone lands or the plan shifts. Keep it honest — it's the
> single source of truth for "where are we / where are we going".
>
> Last updated: 2026-05-29 · HEAD `dd15cbe`

---

## 0. One-liner

A self-hosted control plane that lets you drive Claude Code (and, by design, other coding
agents) from your **phone** — PWA + Capacitor APK — over **Tailscale**, with the desktop CLI
and the phone treated as **views of the same work**: follow live, inject, fork-with-context,
merge back. Privacy stays in your tailnet (no third-party relay).

- Repo: `CoolTao-Yang/agentphone` (PUBLIC, MIT)
- Local dir: `/home/yzt/test/claude4phone` (dir name kept for cwd stability; everything internal = "agentphone")
- Stack: Node + TS, Hono + WebSocket, `@anthropic-ai/claude-agent-sdk`, Capacitor 8 (Android), vanilla JS PWA
- Host: WSL2 (Ubuntu) on Windows; ByteDance corp net (needs Clash proxy `127.0.0.1:7897`)

---

## 1. 现状 — Current state (what works today)

### Architecture
```
phone PWA / APK ──Tailscale──▶ agentphone server (WSL) ──┬─ claude-sdk adapter → spawns claude.exe  (we own)
                                                          ├─ cmax-external adapter → tails CLI's jsonl (follow)
                                                          └─ codex adapter (STUB — throws)
```
- `server/harness/` — HarnessAdapter abstraction (Phase 1). Add a harness without touching ws/sessions.
- `server/harness/cmax-external/` — `tracker.ts` (scans ~/.claude-accounts/*/sessions/*.json + /proc liveness),
  `jsonl-watcher.ts` (fs.watch+poll tail → AgentEvent stream, MIT-derived from clay),
  `jsonl-writer.ts` (inject user msg / mirror entry / merge / history-prefix builder).
- `server/store/` — `links.ts` (phone↔CLI session links), `push.ts` (web-push subscriptions).
- Wire protocol: `shared/types.ts` (ClientMessage / ServerMessage / AgentEvent, all Zod-free hand types).

### Shipped features (by phase / commit)
- **Phase 1** `b1927d2` — HarnessAdapter layer (no behavior change refactor).
- **Phase 2** `dd69173` — event-driven follow-mode; jsonl tail replaces 4s polling.
- **Phase 3** `ab658f8` — bidirectional bridge: 📤 inject into CLI queue, 🔀 fork+mirror.
- **Phase 4** `c5bfa78` — versioned settings (CRDT-style, broadcast to all clients).
- **Phase 5** `c5bfa78` — codex stub adapter (proves the abstraction; throws on startTurn).
- **Phase 6** `455d487` — Web Push notifications on turn_done (VAPID, SW push handler).
- **fork-with-history** `b0b73ef` — new phone session B inherits CLI session A's FULL transcript
  as a `<previous-conversation-context>` prompt prefix (budget-capped ~50k chars, keeps latest turns).
- **merge** `547d0ce` — collapse a phone session's whole transcript into one user message injected to CLI.
- **Streaming render** `e6d5257` (THE big fix) — stable assistant messageId across all stream events
  (was using per-event `m.uuid` → every delta made a new mblock → tables/code never rendered until refresh).
  Plus `67413ee` (merge same-message blocks), `8ddbab9` (paragraph-safe streaming tail), `bc8f540`
  (breaks:true, smart auto-scroll, stream-time hljs, per-message copy).
- **Onboarding** `c2f9c12` + `06c6f19` — USAGE.md, server prints QR (URL+token) + /tmp/agentphone-qr.png,
  APK 📷 QR-scan auto-fill, empty-state env card, multi-account info pill, narrow-phone header CSS.
- **No-redirect APK** `06c6f19` — APK keeps bundled UI, configures server via localStorage, CORS on /api/*.
- **OTA** `71a067f` + `703cef5` — APK probes server on launch, hands off to server-hosted UI;
  `/api/download-apk` auto-fetches latest CI build. UI changes ship without reinstall.
- **Native voice** `6a15d55` — Capacitor speech-recognition plugin (Android SpeechRecognizer, no secure-context needed)
  + in-app update banner.
- **MIUI fix** `34c5a85` — header padding clears status bar / floating capsule.
- Reconnect hardening: ping/pong heartbeat, seq dedup, zombie-WS detection on visibility resume,
  reconnect-timer leak fix, "补齐 0 条" dedup.

### Cowork model (the core value)
| Mode | Same session? | Who drives | Desktop action needed | When |
|---|---|---|---|---|
| 👀 Follow | yes (CLI's A, read-only) | cmax CLI | none | glance at CLI progress from phone |
| 📤 Inject | yes (writes A's queue) | cmax CLI | **press Enter** | both ends active |
| 🔀 Fork-with-history | no (B inherits A's context) | agentphone's claude.exe | none | out & about, async |
| 🔗 Merge | B's transcript → A's queue | cmax CLI | press Enter | bring phone work back |
| + New | no (independent) | agentphone | none | fresh topic |

**Why not just share one session:** two claude.exe both `--resume <jsonl>` race on assistant writes;
loser dies with `ede_diagnostic`. So ownership is exclusive; the modes above are the race-free workarounds.

### Infra / ops
- systemd user service (`agentphone.service`) + `loginctl enable-linger`; survives terminal close.
- `~/.config/agentphone/env` holds: PHONE_AGENT_TOKEN, HTTPS_PROXY/HTTP_PROXY/NO_PROXY (corp net!),
  VAPID_PUBLIC/PRIVATE/SUBJECT. **systemd doesn't inherit shell env — proxy MUST be in this file** or
  claude.exe's api_bootstrap_fetch silently hangs.
- GitHub Actions builds the APK (Node 22 + JDK 21 required for Capacitor 8). `static/dist/agentphone.apk`
  served at `/dist/agentphone.apk` (gitignored).
- `gh` CLI at `~/.local/bin/gh` with persisted PAT.
- SW cache version is the deploy heartbeat — currently around v40+ (bump on every static/ change).

### Known-good verification
- `scripts/test-reconnect.mjs` — reconnect regression guard.
- ad-hoc e2e (`/tmp/test-e2e2.mjs`): new session → prompt → streamed response → turn_done in ~7s.

---

## 2. 理想态 — Ideal state (the vision)

1. **"满血 Claude Code on your phone"** — full-fidelity: every tool call, thinking block, image,
   slash command, markdown/table/code renders exactly as good as the terminal, streaming smoothly.
2. **Truly multi-harness** — claude-sdk + codex + cursor + gemini + opencode all first-class,
   selectable per session. Adding one = one adapter file, zero core changes.
3. **Seamless cowork** — phone and desktop CLI are two windows onto the same work. Context never
   lost when moving between them. No race, no reinstall, no manual sync.
4. **Local-first privacy** — all traffic stays in the user's tailnet. Never an external relay.
5. **Production-grade mobile UX** — push, voice, OTA, offline-tolerant, reconnect-proof, fast cold start,
   onboarding so simple a non-dev could set it up (scan QR, done).
6. **Multi-account, multi-device, multi-user-ready** — switch cmax/cpro accounts at runtime; several
   devices in sync; (stretch) shareable to a teammate.

---

## 3. TODO

> Reprioritized 2026-05-29 after the reference-repo survey (`reference/REPOS.md`). The survey
> exposed 9 concrete gaps; the highest-value ones are pulled up to P0/P1 with the repo to crib from.

### P0 — highest value / friction we keep hitting
- [ ] **Remote tool-approval gate** ⭐ (survey's #1 missing feature). agentphone can inject but can't
      approve/deny a Bash/Edit/MCP tool call from the phone — tools just auto-run or block. Crib:
      `reference/ccpocket` (WS `permission_request`→approve/deny→inject `tool_result`),
      `reference/cui` (`permission-tracker.ts` + injected MCP permission handler, blocks until decided).
- [ ] **Multi-account runtime switch** (no restart). `CLAUDE_CONFIG_DIR` is fixed at boot; switching
      cmax↔cpro1↔cpro2 means editing env + `systemctl restart`. Needs per-spawn env (wrap claude.exe spawn).
- [ ] iOS story — PWA works on iOS but no APK; no native voice; verify push works in iOS PWA.

### P1 — high value
- [ ] **Codex real adapter** — currently a stub that throws. Three concrete shapes from survey, better
      than the planned JSONL-tail: `reference/remodex` (codex `app-server` JSON-RPC over stdio — cleanest),
      `reference/ccpocket` (`claude --input-format stream-json --output-format stream-json` transport),
      `reference/happy` (CLI-wrapper bridge). Also `reference/hapi` codexLocal.ts.
- [ ] **Push semantics beyond binary "turn done"** — classify needs-input / error / plan-ready, debounce,
      only buzz on *unseen* states. Crib: `reference/opensessions` (3 terminal tones, unseen markers),
      `reference/agent-os` (running/waiting/idle/acknowledged flag), `reference/guppi` (multi-layer detection).
- [ ] **Rewind / file checkpointing** — fork-with-history exists but no roll-back of conversation+FS to a
      chosen message. Fully specified in `reference/ccpocket` (`resumeSessionAt:<uuid>` + `rewindFiles(dryRun)`).
- [ ] **Merge/fork write safety** — merge mutates CLI jsonl with NO verification (could corrupt a live
      session). Add read-back verify + atomic write+`.bak` rollback. Crib: `reference/cross_agent_session_resumer`.
- [ ] **Self-healing on context/rate limit** — currently fails silently. Auto-`/compact` on depletion +
      fleet rate-limit coordination + push instead of silent death. Crib: `reference/amux`.
- [ ] Tool-result long output: copy button + expand/collapse (currently 240px max-height scroll only).
- [ ] Realtime token/cost indicator during a turn (elapsed seconds + accumulated $).
- [ ] mirror/merge UX polish — `📱 [phone mirror …] (no text response)` breadcrumbs are noisy;
      make per-turn mirror quieter or off-by-default.

### P2 — robustness / nice to have
- [ ] **JSONL parser hardening** — port a discriminated-union TranscriptEntry schema + golden-file
      fixtures from `reference/claude-code-log` (the most authoritative model of CC's jsonl format;
      handles sidechain/parent-uuid/passthrough). De-risks the follow-mode tailer vs malformed lines.
- [ ] **Declarative harness registry** — `reference/emdash`'s flat `AgentProviderDefinition` (sessionIdFlag,
      resumeFlag, useKeystrokeInjection, supportsHooks…) → adding a harness = one data entry. Hybrid with
      our HarnessAdapter interface.
- [ ] **CRDT upgrade** — replace hand-rolled versioned-settings with `reference/yjs` (delta sync, idempotent
      merge survives dup WS delivery, offline-then-reconnect, presence "who's driving"). Self-hostable (no relay).
- [ ] **OTA health gate** — a bad CI build could brick the hand-off. Add notifyAppReady failsafe + rollback;
      honorable-mention repo `Cap-go/capacitor-updater` (not cloned, pull when doing this).
- [ ] Cursor / Gemini CLI / opencode adapters (validates multi-harness for real).
- [ ] Voice OUTPUT (TTS) polish — Web Speech zh-CN reads replies; iOS WebView support unclear.
- [ ] Visual polish; input-area niceties (paste preview, @file, slash palette).

### P3 — big bets
- [ ] **E2E encryption** so traffic could safely traverse an untrusted relay (escape the Tailscale-only
      assumption). Crib: `reference/happy` (client-side E2E), `reference/remodex` (X25519+HKDF+AES-GCM envelope).
- [ ] **Cleaner pairing** — QR the CLI displays carrying public key (vs our token-in-QR). Crib: `reference/happy`, `reference/remodex`.
- [ ] Desktop Electron/Tauri wrapper so desktop UI == phone UI (one codebase).
- [ ] Cloud-hosted option (for users without a Tailscale/always-on box).
- [ ] Team collab — multiple users, shared/handoff sessions (clay-style "mates").

### Research / reference
- **`UX-BACKLOG.md`** — 51 code-level optimizations ranked by UX-impact/effort (cites our file:line +
  the reference repo to crib from). The "DO 5 FIRST" set is all S-effort, impact-5, independently shippable.
- `reference/REPOS.md` — 19 cloned repos + per-repo borrowable ideas (the survey output).
- `DESIGN.md` — original 5-phase plan + hapi/clay/AGPL-vs-MIT analysis.
- **Closest peer to study first: `reference/happy`** (21k★, slopus, MIT) — mobile+web Claude Code/Codex
  client, the single most overlapping product. `reference/ccpocket` (pushed today) is the runner-up.

---

## 4. Gotchas (learned the hard way)
- systemd ≠ shell env → **proxy must be in env file** (or claude.exe hangs forever, no error surfaced).
- Streaming messageId must be **stable across deltas** (Anthropic envelope uuid changes per event).
- Two claude.exe on one jsonl = race = `ede_diagnostic`. Ownership is exclusive, period.
- Ghost session ids (errored before any jsonl write) → validate `--resume` target exists on disk first.
- WeChat in-app browser ignores Service Worker + has aggressive cache → tell users "open in Chrome" or use APK.
- Capacitor WebView dumps non-localhost navigation to system browser unless `allowNavigation: ['*']`.
- `ede_diagnostic result_type=user` is NOT context-limit — don't mis-classify it as 上下文已满.
