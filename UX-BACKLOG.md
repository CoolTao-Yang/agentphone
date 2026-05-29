# agentphone — UX Optimization Backlog

> Generated 2026-05-29 by a code-level analysis workflow: 10 UX dimensions, each comparing our
> actual code against the cloned reference repos (see reference/REPOS.md). 51 items, ranked by
> UX-impact-per-effort. Cites our file:line + the reference pattern. Effort: S=<2h, M=half-day, L=multi-day.
> Pair with STATE.md (the living state) — this is the actionable detail behind its TODO.
>
> **✅ SHIPPED 2026-05-29** (the "DO 5 FIRST" set): #1 needs-input push · #2 error/rate-limit push ·
> #3 vendored CDN libs locally (static/vendor/, SW v42) · #4 pairing validation · #5 deny-with-reason.
> All push notifications now fire from the TurnRunner (server/runner.ts) — once each, even with zero
> sockets attached.
>
> **✅ SHIPPED 2026-05-29 (round 2):** #7 per-tool rich rendering — Edit/MultiEdit show a real LCS
> line-diff (context grey, del red, add green), Write shows a highlighted code block, Bash shows the
> command + description, Read/Grep/Glob a compact path line; everything else falls back to JSON.
> Tool results cap at 16 lines with inline expand. Replaces the raw-JSON `<pre>` dump.
>
> **✅ SHIPPED 2026-05-29 (round 3):** #6 offline outbox — prompts/injects sent while the socket is
> down are queued (rendered ⏳ 待发送), flushed in order on reconnect via onopen→flushOutbox. One
> prompt queued at a time (avoids concurrent-turn rejection); a queued prompt bound to a session the
> user switched away from is cancelled rather than mis-sent. In-memory (survives network blips; an
> OS app-kill is #12's territory).
>
> **✅ SHIPPED 2026-05-29 (round 4):** #9 drawer unread markers + app badge — a server-side
> attentionStore (set by the TurnRunner on needs_input/error/done) broadcasts to ALL clients so every
> drawer marks the right session live (🔔 needs-input pulsing amber / ⚠️ error / ● done). /api/sessions
> carries it; viewing a session (select_session / mark_seen) clears it; navigator.setAppBadge shows the
> count of actionable (needs_input+error) sessions. Pairs with the #1 needs-input push: push says
> "something needs you", the drawer dot + badge says "it's this session".
>
> Next unstarted high-value: #8 rate-limit countdown · #11 paste-image · #21 slash-command autocomplete ·
> #32 edit-tool-args-before-approve.

# agentphone UX Optimization Backlog

Verified against the live tree: `sendWS` (app.js:1073-1074) silently returns `false` on a dead socket and `sendPrompt` (app.js:1818) bails with a bare `return`; push fires on `turn_done` only (ws.ts:249 — no tool_request/error branch); the three render-critical libs are still loaded from `cdn.jsdelivr.net` (index.html:21-24,227) with no `static/vendor/`; tool input is dumped as `JSON.stringify` (app.js:828); SW is `v41` with no `controllerchange` listener. The findings are accurate and shippable.

## Per-dimension verdict

- **Streaming render fidelity — WEAK.** Streaming markdown/follow-mode is good, but every tool input/result is raw JSON/text with no structure, no diff, no output cap, no running indicator.
- **Tool-call approval & interaction — STRONG core, WEAK surface.** The brief's "no remote approval gate" was OUTDATED: we already ship a real `canUseTool` gate, a three-tier auto-approve model, per-tool CRDT-persisted rules, pending-tool replay on reconnect, and the deny-reason / `updatedInput` paths are *fully plumbed to the SDK*. The gaps are all UI-side: no push when blocked, deny is reason-less, raw-JSON args, no danger signal, can't edit args.
- **Push notification semantics — MISSING the urgent half.** We buzz on DONE (low urgency) and stay silent when BLOCKED or ERRORED (high urgency) — backwards. No typed kinds, no foreground suppression, no unseen state, no debounce.
- **Reconnect / offline resilience — STRONG reconnect, MISSING offline.** Our zombie-socket detection, seq-dedup delta replay, bidirectional heartbeat, and the "补齐 N 条" collapsing separator are genuinely AHEAD of most reference repos. But outbound prompts are silently dropped when offline, there's no draft persistence, and no delivery state.
- **Drawer — WEAK.** Flat list, no unread/blocked marker, cwd repeats per row.
- **Input ergonomics — STRONG on voice/attach, MISSING modern affordances.** Dual-backend STT + native voice is ahead of peers; but no paste-image, no slash/@ autocomplete, no newline on a soft keyboard, no haptics.
- **Error handling & recovery — REACTIVE, two blind spots.** Good reconnect/replay and a context-full card, but rate-limits are entirely unhandled, errors never push, and the stuck-turn watchdog is pure client guesswork that can desync from the runner.
- **Visual design & theming — STRONG baseline, gaps.** A genuinely well-crafted single dark theme; missing light mode, text-scale, reduced-motion, scrollbar styling, and (again) tool diffs.
- **Cold start / PWA — ONE critical regression.** Solid hand-rolled SW, but render-critical libs come from a CDN that's neither precached nor APK-bundled — offline = broken markdown/highlight/QR.
- **Onboarding & pairing — RIGHT model, FRAGILE flow.** Bearer-token-over-tailnet is the correct, appropriately-scoped choice (don't over-build E2E crypto). But commit happens with zero validation, there's no in-app re-pair, and the account pill is read-only.

## Ranked backlog rationale

Ranked by UX-impact-per-effort. The top band is dominated by the **notification inversion** (#1, #2) and the **CDN regression** (#3) because they are S-effort and fix things that are actively broken for a daily phone user, not merely missing. Next come S-effort trust/safety fixes (#4 pairing validation, #5 deny-with-reason — the latter is ~20 lines because the SDK plumbing already exists) and the M-effort items that unlock whole categories: the **offline outbox** (#6, stops silent prompt loss) and the **per-tool renderer** (#7) which simultaneously satisfies the render, approval, and visual-design dimensions — one build, three wins, so it's deduped to a single entry. Mid-pack is the rate-limit card (#8) and drawer unread/badge (#9), then the supporting cast for the notification rework (#10 typed kinds, #16 action buttons, #18 suppression, #26 debounce) which only pay off once #1/#2 land. The long tail (#33-#51) is polish and bandwidth — real, but defer behind anything above.

Deduped: the Edit/Write diff appeared in three dimensions (streaming, approval, visual) → single entry #7. needs_input push appeared in two → #1. Tool-output cap (#42) is kept separate from #7 only because it's the results half and can ship independently.

## DO THESE 5 FIRST

1. **Push when a tool is WAITING for approval (#1, S).** This is the keystone. The entire pitch of agentphone is "approve from your phone" — but today the agent blocks on `canUseTool` and the turn never completes, so `turn_done` never fires and a backgrounded phone gets *nothing*. The agent silently stalls at the exact moment it needs you. Fix it once in `runner.ts` at the `pendingTools.set()` so it fires exactly once regardless of how many sockets are subscribed.
2. **Push on error / rate-limit (#2, S).** The mirror of #1 for failure. A turn that dies from context-full or a rate-limit while you're away leaves you staring at a dead "思考中" forever. ~15 lines next to the existing `turn_done` block. Together #1+#2 convert notifications from "buzzes me when it's done (whenever)" to "buzzes me only when it actually needs me" — the correct urgency model.
3. **Vendor the CDN libs locally (#3, S).** marked, highlight.js, and jsQR are render-critical yet loaded from jsdelivr, so they're neither SW-precached nor APK-bundled. Offline or on flaky cellular — the normal mobile condition — you get no markdown, no code highlighting, and broken QR onboarding, plus every cold start pays a third-party DNS+TLS round-trip first. Copy three files into `static/vendor/`, add to the SHELL list, bump to v42.
4. **Validate the server before committing pairing (#4, S).** First-run is where you lose users. A typo'd Tailscale IP or being off-tailnet currently drops you on a blank hung WebView with no error. We already have `probeServer()` — just call it (plus a token check via `/api/sessions`) before persisting, and show an inline error instead of a dead page.
5. **Deny-with-reason (#5, S).** The single highest-leverage approval fix: the reason is *already plumbed* to the SDK (runner.ts:177 → adapter.ts:150), we just never let the user type it. Today denying means the agent gets a canned rejection and you must wait out the turn to redirect it. Letting you type "no, use ripgrep instead" turns a dead-end into a steering wheel for ~20 lines, almost all UI.

All five are S-effort, uxImpact 5, and independently shippable — a genuine one-weekend set. **Where we're already ahead:** the remote approval gate + three-tier auto-approve, the seq-dedup delta-replay reconnect with its silent-reconnect collapsing separator, and the dual-backend native voice input all beat the closest peers (happy/ccpocket/cui) — don't churn them.

---

## Full ranked backlog (all 51)

| # | item | dim | effort | impact | crib from |
|---|---|---|---|---|---|
| 1 | Push when a tool is WAITING for approval (needs-input push) | Push notification semantics / Tool-call  | S | 5 | cui src/services/permission-tracker.ts:64-94 sendPermissionNotification; guppi p |
| 2 | Push on error / rate-limit, not just done | Error handling / Push semantics | S | 5 | amux/amux-server.py:2173,2227,2286 _push_alert(kind,name,msg) on every self-heal |
| 3 | Vendor marked + highlight.js + jsQR locally (kill the jsdelivr CDN dependency) | Cold start, perf & PWA/SW | S | 5 | claudecodeui/public/sw.js (cache-first self-hosted assets, never a CDN); cui vit |
| 4 | Probe + validate server reachability AND token before committing pairing config | Onboarding & pairing | S | 5 | ccpocket connect_form.dart (validate before commit); happy auth.ts:160-219 (poll |
| 5 | Deny-with-reason: let the user type WHY they're rejecting | Tool-call approval & interaction | S | 5 | ccpocket approval_bar.dart:250-332 (_KeepPlanningCard TextField+send rejects WIT |
| 6 | Offline outbound queue: never silently drop a prompt sent while disconnected | Reconnect / offline resilience | M | 5 | ccpocket bridge_service.dart:804-821 (queue on offline send) + :355 (_flushMessa |
| 7 | Per-tool rich rendering: diff for Edit/Write/MultiEdit, mono for Bash, instead of raw JSON | Streaming render / Tool approval / Visua | M | 5 | cui ToolContent.tsx + EditTool.tsx:38-48 DiffViewer; claudecodeui ToolDiffViewer |
| 8 | Rate-limit / usage-limit detection with reset-time countdown + auto-resume | Error handling & recovery | M | 5 | amux/amux-server.py:1534-1627 (_parse_rate_limit_reset) + badge :14264 + auto-re |
| 9 | Unread marker in the session drawer + app badge for blocked/unseen sessions | Drawer / Push semantics (unseen) | M | 5 | happy storage.ts:559-579 (unread); opensessions tracker.rs:76 mark_seen/:90 dism |
| 10 | Typed notification kinds (needs_input / error / done) with distinct titles, tags & requireInteraction | Push notification semantics | S | 4 | happy pushNotifications.ts:14 SessionNotificationKind + getSessionNotificationTi |
| 11 | Paste-image and drag-drop into the composer | Input ergonomics | S | 4 | claudecodeui useChatComposerState.ts:491-525 (handlePaste+useDropzone); ChatComp |
| 12 | Persist the composer draft per-session so an app kill never loses typed text | Reconnect / offline resilience / Input | S | 4 | remodex CodexComposerDraftPersistence.swift:10-43 (per-thread draft persistence) |
| 13 | In-app 'change server / re-pair' entry + actionable recovery on unauthorized | Onboarding & pairing | M | 5 | remodex CodexService+TrustedPairPresentation.swift (re-pair states); ccpocket co |
| 14 | SW update prompt + auto-reload on controllerchange | Cold start, perf & PWA/SW | S | 4 | cui vite.config.mts registerType:'autoUpdate' (vite-plugin-pwa registerSW wires  |
| 15 | Reconnect/queued banner instead of a tiny status-dot | Reconnect / offline resilience | S | 4 | ccpocket reconnect_banner.dart:6-46 (reconnecting/queued banner copy + spinner) |
| 16 | Notification action buttons (Approve / Deny) from the lock screen | Tool-call approval & interaction | M | 4 | ccpocket notification_service.dart (actionable FCM permission notifications); we |
| 17 | Give user messages a right-aligned tinted bubble so the conversation is scannable | Visual design, readability & theming | S | 4 | happy MessageView.tsx:246-260 (userMessageContainer alignItems flex-end + bubble |
| 18 | Suppress push when a device is actively viewing that session | Push notification semantics | M | 4 | happy pushDispatch.ts:90 isUserActive() suppression; agent-os notifications.ts:7 |
| 19 | primaryTarget extraction + danger badge on the approval card header | Tool-call approval & interaction | M | 4 | ccpocket messages.dart:1534-1703 (PermissionPresentation primaryTarget/riskBadge |
| 20 | Per-message delivery state (pending → sent → failed) with tap-to-retry | Reconnect / offline resilience | M | 4 | remodex CodexMessage.swift:15-19,77 (deliveryState enum) + CodexService+Messages |
| 21 | Slash-command autocomplete menu (/clear, /compact, /model, /help, custom) | Input ergonomics | M | 4 | claudecodeui useSlashCommands.ts (trigger/filter/keyboard-nav/frequency); cui Co |
| 22 | @file mention autocomplete | Input ergonomics | M | 4 | claudecodeui useFileMentions.tsx (detection/fetch/filter/insert); cui Composer.t |
| 23 | Server-authoritative stuck-turn reconciler (replace client 90s guesswork) | Error handling & recovery | M | 4 | guppi reconciler.go:85-122 (ground-truth check → synthetic Completed) + silence. |
| 24 | Auto-retry transient SDK errors instead of making the user retype | Error handling & recovery | M | 4 | amux/amux-server.py:2213-2248 (hard-kill, restart, REPLAY _last_meaningful_user_ |
| 25 | Runtime account switch via CLAUDE_CONFIG_DIR — make the read-only account pill actionable | Onboarding & pairing | M | 4 | happy settings/account.tsx (in-app account management); our twist maps it onto C |
| 26 | Debounce / coalesce rapid pushes within a turn | Push notification semantics | S | 3 | happy pushDispatch.ts:6-12 (per-message pushes removed, one buzz / 10s); happy d |
| 27 | Persist last-sent prompt + '↻ 重发上一条' on the error card | Error handling & recovery | S | 3 | novel (manual counterpart to amux replay-last-message at amux-server.py:2219-222 |
| 28 | enterkeyhint + newline affordance + haptic send confirmation | Input ergonomics | S | 3 | novel (mobile-keyboard ergonomics; RN/Flutter peers get platform send buttons fo |
| 29 | Voice auto-stop on silence + clearer stop/send affordance | Input ergonomics | S | 3 | novel (cui/happy treat recording as explicit start/stop rather than unbounded) |
| 30 | Proactive auto-compact before the window fills (with JSONL backup) | Error handling & recovery | M | 4 | amux/amux-server.py:2157-2174 (parse 'context left until auto-compact: N%', back |
| 31 | Per-kind notification toggles, with 'done' off-by-default | Push notification semantics | M | 3 | agent-os notifications.ts:16-25 defaultSettings completed:false 'Off by default  |
| 32 | Edit tool args before approving (use the already-plumbed updatedInput) | Tool-call approval & interaction | M | 3 | cui permission-tracker.ts:134-157 (updatePermissionStatus accepts modifiedInput  |
| 33 | Light theme + accent via a single data-theme attribute on <html> | Visual design, readability & theming | M | 3 | happy theme.ts (light/dark parallel palettes); claude-code-viewer styles.css:51- |
| 34 | Text-size control (3 steps) via a root font-size variable | Visual design, readability & theming | S | 3 | happy theme.ts sharedSpacing; codium derive.ts:174-188 TYPOGRAPHY token table |
| 35 | Robust connection-string parser: accept bare host:port + agentphone:// deep link | Onboarding & pairing | S | 3 | ccpocket connection_url_parser.dart:24-68 (ccpocket://connect, ws://, bare IP:PO |
| 36 | Render thinking as streaming markdown (fix code-fence tail + only highlight at block end) | Streaming render fidelity | M | 3 | cui MessageItem; happy parseMarkdownBlock |
| 37 | Live waveform + duration while recording voice | Input ergonomics | M | 3 | cui WaveformVisualizer.tsx + useAudioRecording.ts:65-112 |
| 38 | Send lastRenderedSeq on reconnect for true delta replay (cellular bandwidth) | Reconnect / offline resilience | M | 2 | ccpocket bridge_service.dart:725-760 (history delta by fromSeq) + :782-789 (full |
| 39 | Style scrollbars (thin, themed) for message list & tool-result panes | Visual design, readability & theming | S | 2 | claudecodeui index.css:316-355 (.scrollbar-thin + dark) |
| 40 | Honor prefers-reduced-motion to disable always-pulsing animations | Visual design, readability & theming | S | 2 | claudecodeui index.css:220-229 (prefers-reduced-motion block) |
| 41 | Dedup re-sent prompts server-side via clientMsgId (idempotency) | Reconnect / offline resilience | M | 3 | ccpocket bridge_service.dart:838-848 (dedupe key) + :893-905 (cache accepted in- |
| 42 | Cap tool output + running spinner with elapsed seconds | Streaming render fidelity | M | 4 | cui DiffViewer; claudecodeui ClaudeStatus |
| 43 | Group drawer sessions by project cwd | Drawer | M | 3 | emdash project-item.tsx |
| 44 | Reduce per-message vertical overhead from the always-on uppercase 'who' label | Visual design, readability & theming | S | 2 | happy MessageView.tsx:275-289 (agent text has no role label) |
| 45 | Set Cache-Control / ETag on static so shell assets revalidate (304) instead of full re-download | Cold start, perf & PWA/SW | M | 3 | claudecodeui sw.js (hash+immutable for assets, revalidate for entry) |
| 46 | Jitter + give-up/manual-retry state on reconnect backoff | Reconnect / offline resilience | S | 2 | ccpocket bridge_service.dart:791-802 (capped exponential _scheduleReconnect); yj |
| 47 | Stale needs-input auto-clear so a resolved/abandoned block doesn't linger | Push notification semantics | S | 2 | guppi reconciler.go:110 (synthetic completed) + tracker.go:158 StaleTimeout; ope |
| 48 | Inline critical CSS + non-blocking style.css load | Cold start, perf & PWA/SW | S | 2 | novel (standard PWA app-shell pattern) |
| 49 | Content-hash SW cache revisions instead of manual v41 bumping | Cold start, perf & PWA/SW | M | 2 | cui sw.ts:25 precacheAndRoute(self.__WB_MANIFEST) + vite.config.mts injectManife |
| 50 | Surface a 'connected devices' list using the push deviceLabel we already store | Onboarding & pairing | M | 2 | remodex CodexService+TrustedPairPresentation.swift:17-52 (per-device nickname) + |
| 51 | mDNS/Bonjour auto-discovery for same-LAN onboarding | Onboarding & pairing | L | 2 | ccpocket mdns.ts:53-104 (advertiser) + server_discovery_impl_io.dart |

## Per-item detail

### #1 Push when a tool is WAITING for approval (needs-input push)  ·  [S / impact 5]
**Dimension:** Push notification semantics / Tool-call approval

**Problem:** Push fires on exactly one event: turn_done (server/ws.ts:249). When canUseTool parks a Promise (server/runner.ts:181-186) the turn never completes, so a locked/backgrounded phone gets ZERO signal that the agent is blocked. The entire premise of 'approve from your phone' is defeated — the agent silently stalls precisely when it needs the human.

**Fix:** Single source of truth: trigger the push in runner.ts at the pendingTools.set() in start(), keyed off tool_request && !autoApproved, so it fires exactly once regardless of N subscribed sockets. Call sendPushToAll({kind:'needs_input', title:'🔔 Claude 需要确认', body:oneLineSummary(input), tag:`needs-input-${sid}`, url:'/launch', sessionId}). Port oneLineInputSummary (app.js:790) into shared/ for a meaningful lock-screen body ('Bash: rm -rf build/').

**Crib from:** cui src/services/permission-tracker.ts:64-94 sendPermissionNotification; guppi pkg/webpush/sender.go:57 pushes on StatusWaiting; happy permissionHandler.ts:231 kind:'permission'

### #2 Push on error / rate-limit, not just done  ·  [S / impact 5]
**Dimension:** Error handling / Push semantics

**Problem:** server/ws.ts error branch (265-270) sends an 'error' WS message but NO push. A turn that dies from context-full / rate-limit / SDK crash while backgrounded produces zero notification — the user keeps believing Claude is working and stares at a dead '思考中'.

**Fix:** In the runner emit handler's 'error' case in ws.ts, classify the message (reuse realContextLimit / rate-limit / generic regex) and sendPushToAll({kind:'error', title varies '⚠️ 出错了 / 上下文已满 / 已被限流', body:first 140 chars, tag:`err-${sid}`, url:'/launch', sessionId}). ~15 lines mirroring the turn_done block above it.

**Crib from:** amux/amux-server.py:2173,2227,2286 _push_alert(kind,name,msg) on every self-heal path

### #3 Vendor marked + highlight.js + jsQR locally (kill the jsdelivr CDN dependency)  ·  [S / impact 5]
**Dimension:** Cold start, perf & PWA/SW

**Problem:** index.html:21-24,227 load marked, highlight.js + theme CSS, and jsQR from cdn.jsdelivr.net (confirmed live; no static/vendor exists). They are render-critical (app.js:188 falls back to plain <pre> without marked; 264 skips highlighting without hljs) yet are NOT in the SW SHELL (sw.js:7-14) nor bundled in the APK (webDir:'static'). Offline/flaky-cellular = no markdown, no code highlight, broken QR onboarding; every cold start pays jsdelivr DNS+TLS+download.

**Fix:** Copy the three libs + hljs theme CSS into static/vendor/, rewrite the index.html tags to ./vendor/..., add the paths to the SHELL array in sw.js, bump CACHE to v42. A package.json prebuild cp step keeps them fresh. PWA-offline and the bundled APK then render fully with zero third-party network.

**Crib from:** claudecodeui/public/sw.js (cache-first self-hosted assets, never a CDN); cui vite.config.mts injectManifest globPatterns

### #4 Probe + validate server reachability AND token before committing pairing config  ·  [S / impact 5]
**Dimension:** Onboarding & pairing

**Problem:** commit() (static/index.html:199-215) persists URL/token and immediately location.replace(base+'/launch') with zero validation. A typo'd IP / wrong port / off-tailnet drops the user on a blank hung WebView — the worst possible first impression. A probeServer() helper already exists (index.html:112-126) but isn't used on manual/QR commit.

**Fix:** In commit(): show the OTA splash ('连接中…'), call the existing probeServer(p.base), then GET /api/sessions?token= with the 2.5s AbortController to verify the token (200 vs 401), THEN persist + redirect. On failure show an inline error in #bootstrap (keep the typed value); on 401 show '地址对了但 token 不对 — 重新扫码'. ~30 lines reusing existing helpers.

**Crib from:** ccpocket connect_form.dart (validate before commit); happy auth.ts:160-219 (poll auth state, proceed only when authorized)

### #5 Deny-with-reason: let the user type WHY they're rejecting  ·  [S / impact 5]
**Dimension:** Tool-call approval & interaction

**Problem:** The deny button (app.js:876-877) sends {decision:'deny'} with no reason, so the agent always gets the canned '用户...拒绝了' (runner.ts:240). The user can't say 'use ripgrep instead' / 'wrong file' — they must wait out the turn and start a new one to redirect. The reason is ALREADY plumbed to the SDK (runner.ts:177 → adapter.ts:150 message); only the UI + wire field are missing.

**Fix:** Add optional reason?:string to the tool_response wire type (shared/types.ts:10). In appendToolRequest, on 拒绝 reveal an inline text input + send instead of immediately resolving; send {type:'tool_response',toolUseId,decision:'deny',reason}. In ws.ts:434 pass reason into respondToTool; in runner.ts:240 use decision.reason ?? default. ~20 lines, mostly UI.

**Crib from:** ccpocket approval_bar.dart:250-332 (_KeepPlanningCard TextField+send rejects WITH feedback); protocol reject {id, message?}

### #6 Offline outbound queue: never silently drop a prompt sent while disconnected  ·  [M / impact 5]
**Dimension:** Reconnect / offline resilience

**Problem:** sendPrompt() (app.js:1818) bails with a bare `return` when ws.readyState!==1, and sendWS() (app.js:1074) returns false that most callers ignore (confirmed). On mobile the user hits send exactly during the post-background/network-blip dead-zone and the prompt vanishes with no feedback. Zero outbound buffering.

**Fix:** Add module-level `let outbox=[]`. In sendWS(), if not OPEN, push {msg,ts} and return a 'queued' sentinel. In connect() onopen (app.js:1133) after status=connected, flush the outbox in order. In sendPrompt() when queued, still appendUser() locally tagged 'pending' instead of dropping. Clear each entry once ws.send succeeds to avoid double-send.

**Crib from:** ccpocket bridge_service.dart:804-821 (queue on offline send) + :355 (_flushMessageQueue on connect) + :608-621 (requeue in-flight)

### #7 Per-tool rich rendering: diff for Edit/Write/MultiEdit, mono for Bash, instead of raw JSON  ·  [M / impact 5]
**Dimension:** Streaming render / Tool approval / Visual design

**Problem:** appendToolRequest dumps JSON.stringify(input,null,2) into a <pre> for EVERY tool (app.js:828, confirmed) and onToolResult dumps the raw result blob (app.js:914-941). On a 360px phone, approving an Edit means squinting at escaped \n inside JSON to guess what's changing — you cannot safely approve a file edit you can't read; a Bash command is buried in {"command":"..."}. This is the single biggest readability + safety miss (surfaces in 3 dimensions).

**Fix:** Client-side dispatcher keyed on toolName (parallel to cui's ToolContent switch), before the JSON fallback: (a) Edit/MultiEdit → line-by-line del/add diff of old_string vs new_string (~40 lines vanilla, no LCS needed; CSS .diff-line.del bg rgba(248,113,113,.10) / .add rgba(74,222,128,.10)); (b) Write → file_path + code block of content; (c) Bash → mono code block of command + description; (d) Read/Grep/Glob → file/pattern + path; (e) fallback → existing JSON <pre> behind the chevron. Apply the same dispatcher to results, and cap output at ~12 lines + expand.

**Crib from:** cui ToolContent.tsx + EditTool.tsx:38-48 DiffViewer; claudecodeui ToolDiffViewer.tsx (gutter + red/green); happy DiffView.tsx

### #8 Rate-limit / usage-limit detection with reset-time countdown + auto-resume  ·  [M / impact 5]
**Dimension:** Error handling & recovery

**Problem:** Zero handling for Claude usage/rate limits (grep: only our own per-IP throttle in main.ts:160). A '5-hour limit reached, resets at 14:30' renders as a generic red appendError line (app.js:1335): no countdown, no auto-resume, no guidance — the user just sees a cryptic failure and guesses when to retry.

**Fix:** Add a detector in app.js's error switch (next to realContextLimit at 1318): /usage limit|rate limit|too many requests|resets? (at|in)/i. Port amux's _parse_rate_limit_reset (3 TUI formats) as a JS helper to extract a reset epoch. Render a dedicated rate-limit card (clone appendContextFullCard, app.js:974) with a live countdown and a disabled-until-reset resend that re-enables + auto-resends the last prompt at reset. Surface reset time in the status pill.

**Crib from:** amux/amux-server.py:1534-1627 (_parse_rate_limit_reset) + badge :14264 + auto-resume :1824-1935

### #9 Unread marker in the session drawer + app badge for blocked/unseen sessions  ·  [M / impact 5]
**Dimension:** Drawer / Push semantics (unseen)

**Problem:** turn_done for a non-selected session only re-sorts (app.js:1302-1305); a finished or BLOCKED background session looks identical to an idle one. If a needs-input push is missed/swiped, nothing on the app icon or drawer signals 'session X still waiting on you'. activeSessionIds() (ws.ts:92) knows what's RUNNING, not what's BLOCKED-and-unseen.

**Fix:** Client Set unreadSessionIds; mark on busy→idle (app.js:1281) and on needs_input; persist to localStorage; bold the session name + show a dot in the drawer rows (app.js:1449-1483). Server-side: keep a Set of sessionIds in needs_input state (set on tool_request, cleared on tool_decision/turn_done/select_session), broadcast counts; client calls navigator.setAppBadge(count) and clears a session's unseen on select.

**Crib from:** happy storage.ts:559-579 (unread); opensessions tracker.rs:76 mark_seen/:90 dismiss/unseen_instances; agent-os notifications.ts:154 setTabNotificationCount

### #10 Typed notification kinds (needs_input / error / done) with distinct titles, tags & requireInteraction  ·  [S / impact 4]
**Dimension:** Push notification semantics

**Problem:** server/push.ts has one generic payload and ws.ts hardcodes a single done title. Once needs_input + error pushes exist (#1,#2) there's no way for the SW or user to tell a blocking approval from a finished turn from a crash — they'd all look identical. shared/types.ts PushPayload has no kind.

**Fix:** Add kind:'done'|'needs_input'|'error' to PushPayload (push.ts + shared/types.ts). Map kind→title server-side. In sw.js read payload.kind: requireInteraction:true for needs_input/error (stay on lockscreen), false for done; tag `${kind}-${sessionId}`. Prerequisite/companion to #1 and #2.

**Crib from:** happy pushNotifications.ts:14 SessionNotificationKind + getSessionNotificationTitle; guppi tracker.go:24-29 Status enum; agent-os notifications.ts:3

### #11 Paste-image and drag-drop into the composer  ·  [S / impact 4]
**Dimension:** Input ergonomics

**Problem:** app.js has zero clipboard/drop handling (grep confirmed) — images can ONLY be added via the 📷 file picker (app.js:1914-1947). On mobile a screenshot is THE most common thing a user wants to send Claude, and long-press-paste of a screenshot into the textarea silently does nothing.

**Fix:** Reuse the existing pendingImages pipeline. Extract the filePicker 'change' body (app.js:1919-1947) into addImageFiles(files). Add a paste listener on $input: iterate clipboardData.items, getAsFile() any image/*, run through the same validation+fileToBase64. Add dragover/drop on <footer> calling addImageFiles(dataTransfer.files) with a dashed-border overlay while dragging.

**Crib from:** claudecodeui useChatComposerState.ts:491-525 (handlePaste+useDropzone); ChatComposer.tsx:254-302 (drop overlay)

### #12 Persist the composer draft per-session so an app kill never loses typed text  ·  [S / impact 4]
**Dimension:** Reconnect / offline resilience / Input

**Problem:** The composer is only $input.value in the DOM (app.js:302, read at 1816). Android freezes/kills backgrounded PWAs; iOS reloads on memory pressure. Any half-typed long (often voice-dictated) prompt is gone. We persist serverUrl/token/apkBuildNumber but nothing about the composer.

**Fix:** On $input 'input', debounce-write localStorage[`agentphone:draft:${currentSessionId||'new'}`]=value; clear on successful send. On boot and on session_set, restore $input.value + autoResize(). ~25 lines.

**Crib from:** remodex CodexComposerDraftPersistence.swift:10-43 (per-thread draft persistence)

### #13 In-app 'change server / re-pair' entry + actionable recovery on unauthorized  ·  [M / impact 5]
**Dimension:** Onboarding & pairing

**Problem:** There is NO in-app way to change server URL or re-scan a QR — the only documented reset is 'long-press icon → app info → clear storage' (index.html:244-246), which nukes ALL state. On token rotation the APK didn't reach via /launch, the user lands on the dead-end 'token 错误' (app.js:1340-1344,1364).

**Fix:** Add a settings/overflow entry opening a modal showing current serverUrl + masked token, with '重新扫码' (refactor the jsQR scanner index.html:259-325 into reusable openScanner(onResult)) and '手动改地址'. On new config, set the two pairing keys only (not everything) and location.replace(newBase+'/launch'). When WS closes 4001 / 'unauthorized', render a banner with a one-tap '重新配对' opening this same modal.

**Crib from:** remodex CodexService+TrustedPairPresentation.swift (re-pair states); ccpocket connect_form.dart (scan always reachable)

### #14 SW update prompt + auto-reload on controllerchange  ·  [S / impact 4]
**Dimension:** Cold start, perf & PWA/SW

**Problem:** sw.js skipWaiting()s on install and clients.claim()s on activate, but app.js has no controllerchange listener (confirmed). On a new static/ deploy a running tab keeps the OLD app.js while the NEW SW takes control — split-brain with no reload signal. The only freshness path is the manual 🔄 button (app.js:2225), which reloads session data, not code.

**Fix:** After navigator.serviceWorker.register, add reg 'updatefound' → when the new worker reaches 'installed' with an existing controller, show the existing showToast '新版本已就绪 · 点此刷新' wired to location.reload(); also add a one-shot controllerchange→location.reload() for idle tabs.

**Crib from:** cui vite.config.mts registerType:'autoUpdate' (vite-plugin-pwa registerSW wires updatefound→prompt→reload)

### #15 Reconnect/queued banner instead of a tiny status-dot  ·  [S / impact 4]
**Dimension:** Reconnect / offline resilience

**Problem:** On disconnect we only flip a dot+text to '断开,重连中' (app.js:1365); on watchdog/zombie reconnects we say nothing. The user has no idea whether a just-sent message went out, is queued, or was lost — the trust gap behind 'I'm not sure if it sent'.

**Fix:** Add a thin full-width banner driven off connection state: reconnecting → '重连中…已排队 N 条' (N=outbox.length from #6); offline-with-queue → '离线 · N 条待发送'; connected → hide. Wire it in setStatus() so it stays in sync with the dot. Pairs with #6.

**Crib from:** ccpocket reconnect_banner.dart:6-46 (reconnecting/queued banner copy + spinner)

### #16 Notification action buttons (Approve / Deny) from the lock screen  ·  [M / impact 4]
**Dimension:** Tool-call approval & interaction

**Problem:** Even once we push on pending tools (#1), the SW notification (sw.js:43-52) has no actions, so the user must open the PWA, wait for WS reconnect, scroll to the card, and tap. For a trusted 'approve this one Read' that's a lot of friction from a locked phone.

**Fix:** Add actions:[{action:'approve',title:'✓ 批准'},{action:'deny',title:'✗ 拒绝'}] to showNotification, include toolUseId in push data. Handle event.action in notificationclick (sw.js:55): POST to a new /api/tool-decision {toolUseId,decision} (or postMessage an open client) → runner.respondToTool. Well-supported on Android Chrome (the APK target).

**Crib from:** ccpocket notification_service.dart (actionable FCM permission notifications); web Notifications API actions

### #17 Give user messages a right-aligned tinted bubble so the conversation is scannable  ·  [S / impact 4]
**Dimension:** Visual design, readability & theming

**Problem:** appendUser (app.js:748-787) renders user turns with the same flat .body layout as assistant turns; the only signal is the 10.5px uppercase '你' label. On a long mobile scroll, prompts and replies blur into one indistinguishable column — you lose your place and can't find 'what did I ask'.

**Fix:** Pure CSS, no JS change: .msg.user{display:flex;flex-direction:column;align-items:flex-end} .msg.user .body{background:var(--surface-2);border:1px solid var(--border);border-radius:14px 14px 4px 14px;padding:8px 12px;max-width:85%;text-align:left;white-space:pre-wrap}. Optionally drop the '你' label once bubbled.

**Crib from:** happy MessageView.tsx:246-260 (userMessageContainer alignItems flex-end + bubble)

### #18 Suppress push when a device is actively viewing that session  ·  [M / impact 4]
**Dimension:** Push notification semantics

**Problem:** push.ts sendToAll fans out to EVERY subscription unconditionally. If you're in the app watching the stream, turn_done still fires a lockscreen buzz — redundant and annoying. The client tracks document.hidden (app.js:2442,2500) but never tells the server.

**Fix:** Client sends {type:'presence',state:'active'|'background',sessionId} on visibilitychange (app.js:2500) and connect. Track per-connection in ws.ts (Map). Before sendPushToAll on done/needs_input, skip if any live connection is active on that sessionId (still allow an in-tab Notification). Keep error pushes unsuppressed.

**Crib from:** happy pushDispatch.ts:90 isUserActive() suppression; agent-os notifications.ts:79 (only send if not focused)

### #19 primaryTarget extraction + danger badge on the approval card header  ·  [M / impact 4]
**Dimension:** Tool-call approval & interaction

**Problem:** oneLineInputSummary (app.js:790) returns one truncated string with no semantics, and there is NO risk signal anywhere (grep: nothing). A `git push --force` / `rm -rf` renders with the exact same visual weight as Read. On a phone where you tap fast, that's how you fat-finger-approve something destructive.

**Fix:** Derive {primaryTargetLabel, primaryTarget} per category (Command/File/URL/Pattern) and render primaryTarget in a mono card under the title. Add a danger heuristic on Bash (rm -rf, sudo, force-push, curl|sh, chmod 777, > /dev/, dd of=) and Write/Edit outside cwd → red 'risky' badge + color the 批准 button red / require a deliberate second tap. Server can flag it so the push body carries '⚠'.

**Crib from:** ccpocket messages.dart:1534-1703 (PermissionPresentation primaryTarget/riskBadge) + approval_bar.dart:214-247

### #20 Per-message delivery state (pending → sent → failed) with tap-to-retry  ·  [M / impact 4]
**Dimension:** Reconnect / offline resilience

**Problem:** User bubbles render via appendUser() with no delivery state — once shown they look identical whether the server received the prompt or not. Combined with the silent-drop bug (#6), a user can stare at their own message believing it was received. shared/types.ts prompt has no id, so we can't ack or dedup.

**Fix:** Add clientMsgId (crypto.randomUUID()) to the prompt wire message and echo it back via a tiny prompt_ack ServerMessage (or first agent_event). Render the user bubble with data-delivery=pending; flip to 'sent' on ack; on flush failure / backoff ceiling flip to 'failed' with a ↻ that re-queues. CSS: clock glyph for pending, red ↻ for failed.

**Crib from:** remodex CodexMessage.swift:15-19,77 (deliveryState enum) + CodexService+Messages.swift:1307,1338-1339 (pending→confirmed on echo)

### #21 Slash-command autocomplete menu (/clear, /compact, /model, /help, custom)  ·  [M / impact 4]
**Dimension:** Input ergonomics

**Problem:** No slash commands from the composer — typing '/' is sent as literal text. Power users expect /compact, /clear; on mobile they're even more valuable since typing the full command on a soft keyboard is painful. No code path exists (grep).

**Fix:** Detect a leading-slash token in $input 'input' (textBeforeCursor.match(/^\/(\S*)$/), skip inside ``` fences). Render an absolutely-positioned list above the composer; ArrowUp/Down + Tab/Enter to insert. Start with a hardcoded built-in set; later add GET /api/commands reading ~/.claude/commands. Persist per-command usage count in localStorage to sort frequent first.

**Crib from:** claudecodeui useSlashCommands.ts (trigger/filter/keyboard-nav/frequency); cui Composer.tsx:493-513 detectSlashCommandAutocomplete

### #22 @file mention autocomplete  ·  [M / impact 4]
**Dimension:** Input ergonomics

**Problem:** No way to reference a project file without hand-typing the full path. On a phone, typing /home/yzt/test/.../foo.ts is brutal, yet 'look at @app.js' is a top-frequency Claude interaction. No file index, no @ trigger (grep).

**Fix:** Add GET /api/files?cwd=<session cwd> (we already track cwd per session — sessions.ts:129) returning flattened {name,relativePath}, capped depth/count, skipping node_modules/.git. Client: detect the @-token before cursor (lastIndexOf('@'), bail on whitespace), fuzzy-filter name+path, slice 10, splice the path on select. Reuse the slash-command dropdown so keyboard-nav is shared.

**Crib from:** claudecodeui useFileMentions.tsx (detection/fetch/filter/insert); cui Composer.tsx:475-491 detectAutocomplete

### #23 Server-authoritative stuck-turn reconciler (replace client 90s guesswork)  ·  [M / impact 4]
**Dimension:** Error handling & recovery

**Problem:** The busy watchdog (app.js:493-519) is a 90s client timer that never verifies reality. Its force-clear flips a local boolean — if the server turn is alive the next send hits '已经有一个回合在进行了' (ws.ts:501); if dead-but-silent the client stays at 思考中 forever. External follow-mode turns have no stuck detection at all.

**Fix:** Add a 10-15s server reconciler. SDK runner: if runner.active non-null but no event >90s, push {type:'turn_stalled',sinceSec} so the banner reflects server truth and force-clear can call interrupt() server-side. External: tracker.ts already has processAlive+updatedAt — flag status='stuck' when busy && now-updatedAt>90s && alive, clear/flip to idle when the process is gone.

**Crib from:** guppi reconciler.go:85-122 (ground-truth check → synthetic Completed) + silence.go:153-230

### #24 Auto-retry transient SDK errors instead of making the user retype  ·  [M / impact 4]
**Dimension:** Error handling & recovery

**Problem:** On ede_diagnostic / result_type=user transient failures we show 'SDK 抖动·再发一次' (app.js:1327-1332) and the user must manually retype + resend the exact same prompt. We already capture it server-side (myCurrentTurnPrompt in ws.ts) — we throw away a free retry.

**Fix:** In runner.ts catch (208-224), classify: if transient (ede_diagnostic, stream parse, overloaded_error/529) and retries<1, wait ~1.5s and re-run the same opts ONCE before recording {kind:'error'}. Emit {type:'auto_retry'} so the client shows '检测到抖动, 自动重试中…'. Cap at 1; never auto-retry context-limit or tool-denial.

**Crib from:** amux/amux-server.py:2213-2248 (hard-kill, restart, REPLAY _last_meaningful_user_message on corruption)

### #25 Runtime account switch via CLAUDE_CONFIG_DIR — make the read-only account pill actionable  ·  [M / impact 4]
**Dimension:** Onboarding & pairing

**Problem:** Tapping the account pill (app.js:568-595) and GET /api/accounts (main.ts:173-197) are READ-ONLY: the modal tells the user to SSH in, edit env, and systemctl restart. For a phone-first control plane this defeats the purpose (main.ts:175 marks runtime switch a P1 TODO).

**Fix:** Add POST /api/accounts/active {name} (token-gated). Validate name under ~/.claude-accounts/, set module-level + process.env.CLAUDE_CONFIG_DIR, persist into ~/.config/agentphone/env. Since the SDK spawns claude per-turn inheriting process.env, NEW sessions pick up the switch immediately; toast 'account 已切换 — 新建 session 生效' + refresh the pill. Replace the alert() with a tap-to-switch list. Guard: warn/block while a turn is busy.

**Crib from:** happy settings/account.tsx (in-app account management); our twist maps it onto CLAUDE_CONFIG_DIR

### #26 Debounce / coalesce rapid pushes within a turn  ·  [S / impact 3]
**Dimension:** Push notification semantics

**Problem:** Adding needs_input pushes (#1) naively means a turn requesting 5 tools buzzes 5 times in seconds. happy explicitly removed per-message pushes for this. We currently dodge it only by not pushing mid-turn at all.

**Fix:** In push.ts add a tiny in-memory dedup keyed by tag: last-sent timestamp; drop a same-tag push sent <~8s ago. For needs_input, only push for the FIRST pending tool of a turn (one tap takes the user into the app where they see all cards). Ship alongside #1.

**Crib from:** happy pushDispatch.ts:6-12 (per-message pushes removed, one buzz / 10s); happy debounce.ts

### #27 Persist last-sent prompt + '↻ 重发上一条' on the error card  ·  [S / impact 3]
**Dimension:** Error handling & recovery

**Problem:** If a turn errors, the user's draft is gone and the captured prompt lived in a server var cleared on error (ws.ts:267). Retyping a long voice-dictated prompt after a failure is painful; appendError (app.js:963) is plain text with no resend affordance.

**Fix:** Keep lastSentPrompt in a client var set in the send handler. On any 'error' event, attach a '↻ 重发上一条' button to the error card that re-populates $input (or directly resends). Fully client-side; complements the server auto-retry (#24) for the cases it deliberately skips.

**Crib from:** novel (manual counterpart to amux replay-last-message at amux-server.py:2219-2226)

### #28 enterkeyhint + newline affordance + haptic send confirmation  ·  [S / impact 3]
**Dimension:** Input ergonomics

**Problem:** The textarea (index.html:370-372) has no enterkeyhint (generic Return key), and app.js:2186-2191 sends on ANY Enter, so on a phone there's NO way to insert a newline — multi-line prompts (paste a stack trace, then add a question) are effectively impossible. No haptic confirms a send.

**Fix:** Add enterkeyhint="send". Gate Enter-to-send behind matchMedia('(pointer: fine)') so phones get newline-on-Return + tap-↑-to-send while desktops keep Enter-to-send. On successful sendPrompt fire navigator.vibrate(10) / Capacitor Haptics.impact.

**Crib from:** novel (mobile-keyboard ergonomics; RN/Flutter peers get platform send buttons for free)

### #29 Voice auto-stop on silence + clearer stop/send affordance  ·  [S / impact 3]
**Dimension:** Input ergonomics

**Problem:** startSTT (app.js:2136-2151) is pure toggle — tap to start, tap to stop. If the user forgets the second tap the native recognizer keeps listening / drains battery, and the UI gives no 'tap to send' cue.

**Fix:** Add an inactivity timer: each partialResults/onresult resets a 2.5s setTimeout that calls stt.stop(); clear on real stop. Optionally make the send button a 'stop+send' while recording so a long press ends recording AND fires sendPrompt. Keep tap-to-stop as manual override.

**Crib from:** novel (cui/happy treat recording as explicit start/stop rather than unbounded)

### #30 Proactive auto-compact before the window fills (with JSONL backup)  ·  [M / impact 4]
**Dimension:** Error handling & recovery

**Problem:** appendContextFullCard (app.js:974) only appears AFTER a turn has failed with 'context window exceeded'. The user loses the turn they just waited on, then manually clicks compact. We never warn or act while there's still room.

**Fix:** The SDK result event carries token usage. In runner.ts compute used/window; when remaining <~25% emit {type:'context_low',pct}. Client shows a non-blocking banner '上下文快满了 (剩 N%) — 现在压缩?' with one-tap /compact. Optional user-configurable auto-fire threshold in CRDT settings; back up JSONL before compaction.

**Crib from:** amux/amux-server.py:2157-2174 (parse 'context left until auto-compact: N%', backup<30%, /compact<50% with cooldown, post_compact_continue)

### #31 Per-kind notification toggles, with 'done' off-by-default  ·  [M / impact 3]
**Dimension:** Push notification semantics

**Problem:** We have one all-or-nothing notifyOnDone flag (app.js:2264). A power user running many turns gets buzzed on every completion with no way to keep only urgent needs_input/error pushes; no settings surface for prefs.

**Fix:** Add a prefs object {needs_input:true,error:true,done:false} in localStorage synced into the existing CRDT agentSettings (ws.ts:42). Server consults flags before each kind's sendPushToAll. Three checkboxes in the settings UI. Default done OFF so the baseline is 'only buzz me when you actually need me'.

**Crib from:** agent-os notifications.ts:16-25 defaultSettings completed:false 'Off by default - noisy'

### #32 Edit tool args before approving (use the already-plumbed updatedInput)  ·  [M / impact 3]
**Dimension:** Tool-call approval & interaction

**Problem:** The updatedInput path is fully wired (runner.ts:162 returns it, adapter.ts:146 forwards to the SDK) but the UI never exposes it — the user can only allow-as-is or deny. When the agent proposes 'rm -rf node_modules build dist' and you want only node_modules removed, you must deny and re-prompt.

**Fix:** For Bash make command (and for Write/Edit the path) an editable field in the approval card; on 批准 send tool_response with an added updatedInput field. ws.ts:434 passes it into respondToTool; runner.ts resolves {allow:true,updatedInput}. Guard: only allow known-safe fields (command/file_path/content).

**Crib from:** cui permission-tracker.ts:134-157 (updatePermissionStatus accepts modifiedInput on approve)

### #33 Light theme + accent via a single data-theme attribute on <html>  ·  [M / impact 3]
**Dimension:** Visual design, readability & theming

**Problem:** color-scheme is hardcoded dark (index.html:7) with a single :root palette (style.css:7-27); no light option, no personalization. We're the only peer with zero theme choice (happy/cui/claudecodeui/ccviewer all ship light+dark).

**Fix:** All colors already route through CSS vars, so cheap: add :root[data-theme=light]{...} alongside dark; header ☀/🌙 toggle sets document.documentElement.dataset.theme + persists; honor prefers-color-scheme on first load; update meta theme-color + color-scheme in app.js. Note --accent-2 (#fbbf24) needs a darker light-mode value for contrast.

**Crib from:** happy theme.ts (light/dark parallel palettes); claude-code-viewer styles.css:51-123 (:root + .dark swap)

### #34 Text-size control (3 steps) via a root font-size variable  ·  [S / impact 3]
**Dimension:** Visual design, readability & theming

**Problem:** Body is fixed 15.5px/1.62 (style.css:379); no way to make output denser (more on screen) or larger (accessibility). A PWA/APK has no browser-zoom chrome, so we must offer it in-app.

**Fix:** Introduce --fs-scale on :root (default 1); set html{font-size:calc(16px*var(--fs-scale))} and convert key .body/.tool-body px to rem/em. Add an S/M/L cycle (0.9/1.0/1.15) in the settings/effort dropdown, persisted to localStorage. Lowest-effort: three classes on #app overriding --fs-scale.

**Crib from:** happy theme.ts sharedSpacing; codium derive.ts:174-188 TYPOGRAPHY token table

### #35 Robust connection-string parser: accept bare host:port + agentphone:// deep link  ·  [S / impact 3]
**Dimension:** Onboarding & pairing

**Problem:** parseConfigUrl (index.html:68-78) only handles URL-parseable input and REQUIRES ?token= or commit() alerts 'URL 里没带 token'. A user typing just '100.119.115.75:8765' is rejected with no graceful handling; no deep link so a tapped link can't auto-configure the APK.

**Fix:** Accept bare host:port (^[\w.\-]+:\d+$ → prefix http://) and full URLs with ?token. Register an Android intent-filter for agentphone://connect?url=&token= (Capacitor App.addListener('appUrlOpen')) so the desktop QR/link configures the APK in one tap. Make 'token 缺失' an inline hint, not a blocking alert.

**Crib from:** ccpocket connection_url_parser.dart:24-68 (ccpocket://connect, ws://, bare IP:PORT)

### #36 Render thinking as streaming markdown (fix code-fence tail + only highlight at block end)  ·  [M / impact 3]
**Dimension:** Streaming render fidelity

**Problem:** Thinking is plain text via textContent (app.js:682); the escaped tail shows streaming code as wrapped text and highlight reruns each tick (app.js:688).

**Fix:** Render thinking via renderMarkdownStream inside a <details>; wrap an odd/open fence tail in <pre><code>; drop the per-tick highlight at app.js:689 and only highlight at block end.

**Crib from:** cui MessageItem; happy parseMarkdownBlock

### #37 Live waveform + duration while recording voice  ·  [M / impact 3]
**Dimension:** Input ergonomics

**Problem:** During voice the mic only pulses (style.css:719-726) — no amplitude feedback, no elapsed time, so the user can't tell the mic is hearing them (a frequent phone failure: mic occluded/too quiet).

**Fix:** On record start, swap the input for a thin canvas waveform strip (cui's WaveformVisualizer is ~190 lines of pure canvas). Web fallback: getUserMedia → AudioContext analyser → getByteFrequencyData into the canvas. Native APK: approximate from partialResults cadence or open the mic stream purely for the analyser. Show an mm:ss counter.

**Crib from:** cui WaveformVisualizer.tsx + useAudioRecording.ts:65-112

### #38 Send lastRenderedSeq on reconnect for true delta replay (cellular bandwidth)  ·  [M / impact 2]
**Dimension:** Reconnect / offline resilience

**Problem:** ws.ts:343 sends the ENTIRE turn buffer on every 'connected' though runner.ts:85 activeState(sinceSeq) supports a delta, and buildWsUrl (app.js:48-65) never passes lastRenderedSeq. On a long turn the user re-downloads the whole transcript every background/foreground over cellular (client dedups, but bytes were paid).

**Fix:** Append &sinceSeq=<lastRenderedSeq>&turnId=<lastTurnId> to buildWsUrl on reconnect. Server: if turnId matches send only seq>sinceSeq; if it differs send full buffer + a clear flag → client clearMessages(). Graceful full-snapshot fallback.

**Crib from:** ccpocket bridge_service.dart:725-760 (history delta by fromSeq) + :782-789 (full-history fallback)

### #39 Style scrollbars (thin, themed) for message list & tool-result panes  ·  [S / impact 2]
**Dimension:** Visual design, readability & theming

**Problem:** No scrollbar styling anywhere (confirmed: zero ::-webkit-scrollbar). On Android WebView / desktop PWA the default chunky light bar clashes with #0d0c0b; overflow-x panes show a bright default horizontal bar — unpolished against an otherwise careful UI.

**Fix:** Add scrollbar-width:thin + scrollbar-color:var(--muted-2) transparent to the scroll containers and the webkit equivalents (*::-webkit-scrollbar{width:6px;height:6px}; thumb var(--muted-2) radius 3px; track transparent). Purely additive.

**Crib from:** claudecodeui index.css:316-355 (.scrollbar-thin + dark)

### #40 Honor prefers-reduced-motion to disable always-pulsing animations  ·  [S / impact 2]
**Dimension:** Visual design, readability & theming

**Problem:** ~8 infinite animations (busy-dot pulse, running pulse-dot, mic pulse-rec, ota-spin) run with no reduced-motion guard. A persistently pulsing header dot is distracting for motion-sensitive users; OS-level 'reduce motion' is ignored.

**Fix:** Add @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}. Swap busy/running pulses for a static high-contrast color so state is still conveyed. One block, no JS.

**Crib from:** claudecodeui index.css:220-229 (prefers-reduced-motion block)

### #41 Dedup re-sent prompts server-side via clientMsgId (idempotency)  ·  [M / impact 3]
**Dimension:** Reconnect / offline resilience

**Problem:** Once #6 (outbox) + #20 (retry) exist, a flaky link can deliver the same prompt twice (resend on reconnect after the first actually landed). No idempotency key, so the agent runs the turn twice — costly and confusing.

**Fix:** When prompt carries clientMsgId, ws.ts remembers the last N processed ids per session (Set/LRU). In the prompt handler (~ws.ts:495-562) skip starting a turn if the id was seen; re-send the existing ack instead. Depends on #20 having added clientMsgId.

**Crib from:** ccpocket bridge_service.dart:838-848 (dedupe key) + :893-905 (cache accepted in-flight input)

### #42 Cap tool output + running spinner with elapsed seconds  ·  [M / impact 4]
**Dimension:** Streaming render fidelity

**Problem:** Tool result text is uncapped (app.js:914-938) and floods the DOM; a pending tool is a static card (app.js:820) with no sense it's actively running.

**Fix:** Show first ~12 lines + expand button on results; add a CSS running pulse + a 'busy' pill with elapsed seconds on a pending/running tool card. Folds naturally into the per-tool renderer (#7).

**Crib from:** cui DiffViewer; claudecodeui ClaudeStatus

### #43 Group drawer sessions by project cwd  ·  [M / impact 3]
**Dimension:** Drawer

**Problem:** Flat sort interleaves same-repo sessions and the cwd string repeats on every row (app.js:1461), wasting space and scannability.

**Fix:** Collapsible cwd group headers; pin the active group to the top; drop the per-row cwd line. Pairs with the unread marker (#9) in the same drawer pass.

**Crib from:** emdash project-item.tsx

### #44 Reduce per-message vertical overhead from the always-on uppercase 'who' label  ·  [S / impact 2]
**Dimension:** Visual design, readability & theming

**Problem:** .who renders on every message (app.js:755,806,921) as a 10.5px uppercase row with 5px margin; across a long session it's repeated chrome, and consecutive assistant blocks are already merged so the label is often redundant.

**Fix:** CSS-only: .msg.assistant + .msg.assistant .who{display:none} and tighten .who margin-bottom to 3px; pair with the user-bubble change (#17) where the label becomes unnecessary. Reclaims ~16px per merged block.

**Crib from:** happy MessageView.tsx:275-289 (agent text has no role label)

### #45 Set Cache-Control / ETag on static so shell assets revalidate (304) instead of full re-download  ·  [M / impact 3]
**Dimension:** Cold start, perf & PWA/SW

**Problem:** server/main.ts:407 is bare serveStatic with no Cache-Control/ETag/Last-Modified. With SW network-first-for-shell, every boot full-re-downloads app.js (108KB) + style.css (40KB) over Tailscale/cellular even when nothing changed — no 304 path.

**Fix:** Pass serveStatic an onFound hook to set headers per path: immutable long max-age for hashed/vendored assets, no-cache + content-hash ETag for index.html/app.js/style.css so the browser/SW can do conditional GETs.

**Crib from:** claudecodeui sw.js (hash+immutable for assets, revalidate for entry)

### #46 Jitter + give-up/manual-retry state on reconnect backoff  ·  [S / impact 2]
**Dimension:** Reconnect / offline resilience

**Problem:** app.js:1368 backoff is linear Math.min(8000,500*(1+attempts)) with no jitter and no ceiling — it retries forever at 8s. If the server is truly down the phone burns battery every 8s with no 'tap to retry' off-ramp and no visible give-up state.

**Fix:** Exponential-with-jitter: base=Math.min(30000,1000*2**attempts); wait=base/2+Math.random()*base/2. After ~8 attempts stop the loop, set status '连接失败 · 点此重试', make the banner (#15) tappable to reset attempts + connect().

**Crib from:** ccpocket bridge_service.dart:791-802 (capped exponential _scheduleReconnect); yjs/y-websocket jitter convention

### #47 Stale needs-input auto-clear so a resolved/abandoned block doesn't linger  ·  [S / impact 2]
**Dimension:** Push notification semantics

**Problem:** Once the unseen/needs_input state (#9) exists, it could get stuck showing 'waiting' if the turn later errors or the desktop CLI answers it.

**Fix:** Clear the session from needs_input on turn_done OR error OR a tool_decision for that pending tool, and broadcast the updated badge; optionally have the SW close the matching notification via getNotifications({tag}) on focus. Add a long stale timeout (~24h) to drop orphaned entries. Folds into #9.

**Crib from:** guppi reconciler.go:110 (synthetic completed) + tracker.go:158 StaleTimeout; opensessions agent_watchers.rs:92 STUCK_MS→Stale

### #48 Inline critical CSS + non-blocking style.css load  ·  [S / impact 2]
**Dimension:** Cold start, perf & PWA/SW

**Problem:** index.html:19 loads style.css (40KB) as a render-blocking <link> with no preload and zero resource hints. On a cold Tailscale load first paint waits on the full CSS; the OTA splash also depends on style.css parsing → white flash.

**Fix:** Inline the ~1KB above-the-fold CSS (#ota-splash + #bootstrap + header skeleton) into a <style> in <head>; load the big style.css via rel=preload + onload swap (SW-cached anyway). Removes the white flash before the splash.

**Crib from:** novel (standard PWA app-shell pattern)

### #49 Content-hash SW cache revisions instead of manual v41 bumping  ·  [M / impact 2]
**Dimension:** Cold start, perf & PWA/SW

**Problem:** sw.js:5 hand-increments CACHE='agentphone-shell-v41' and the SHELL list is hand-maintained — forget to bump → users stuck on old UI; a new asset silently won't precache.

**Fix:** Build step stamps a hash (git short-sha or a manifest of file mtimes/sizes) into sw.js / a generated static/sw-manifest.json; key the cache name on the overall hash and precache from the manifest. Mirrors Workbox __WB_MANIFEST without adopting Vite.

**Crib from:** cui sw.ts:25 precacheAndRoute(self.__WB_MANIFEST) + vite.config.mts injectManifest

### #50 Surface a 'connected devices' list using the push deviceLabel we already store  ·  [M / impact 2]
**Dimension:** Onboarding & pairing

**Problem:** We persist deviceLabel on every push subscription (main.ts:314, from navigator.userAgent app.js:2418) but NEVER show it — no visibility into paired phones, no way to revoke a lost device.

**Fix:** Add GET /api/devices (token-gated) returning {deviceLabel, endpoint-hash, createdAt}; list them in the settings/re-pair modal (#13) with a remove button calling the existing DELETE /api/push/subscribe. Optional friendly nickname keyed by endpoint. No crypto identity — labels only, auth is the shared token.

**Crib from:** remodex CodexService+TrustedPairPresentation.swift:17-52 (per-device nickname) + SecureStore.swift:18-20

### #51 mDNS/Bonjour auto-discovery for same-LAN onboarding  ·  [L / impact 2]
**Dimension:** Onboarding & pairing

**Problem:** The only way to learn the server address is reading the Tailscale IP off the terminal (index.html:240-243). On the same LAN this is pure friction.

**Fix:** Optional server-side mDNS advertiser (bonjour-service) publishing _agentphone._tcp on PORT behind an AGENTPHONE_MDNS=1 flag in try/catch. Lower priority than validation/re-pair since Tailscale is the primary transport — ship only if LAN onboarding becomes a real complaint.

**Crib from:** ccpocket mdns.ts:53-104 (advertiser) + server_discovery_impl_io.dart
