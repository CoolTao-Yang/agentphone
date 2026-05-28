# agentphone

> Drive your local coding agent from your phone — over Tailscale, end‑to‑end encrypted, no public exposure.

`agentphone` is a tiny Node + TypeScript server that runs alongside your
local coding agent (Claude Code today; Codex / Cursor are wired into the
same interface) and exposes a mobile‑first PWA. The phone connects via
Tailscale and gets a full chat UI with streaming, tool approval, voice
I/O, image attachments and seamless reconnect.

Repository → <https://github.com/CoolTao-Yang/agentphone>

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  phone   (Chrome PWA)       │         │  desktop / WSL  (Node + Hono)│
│                             │         │                              │
│  /launch  →  ?token=…       │ ─ WSS ──┤  /ws            chat stream  │
│                             │ ─ REST ─┤  /api/sessions  list/label   │
│  add to home screen         │ ─ REST ─┤  /api/sessions/:id/messages  │
│  ⚡ ⚙ 🔈 ☰ 🎤 📷 ↑          │         │  /api/recent-cwds            │
└─────────────────────────────┘         │     │                        │
              ▲                          │     ▼                        │
              │ Tailscale tunnel         │  TurnRunner (replay buffer)  │
              │ (no port forwards)       │     │                        │
              ▼                          │     ▼                        │
       ────────────────                  │  Agent interface             │
        100.x.x.x:8765                   │   └── ClaudeAgent (SDK)      │
                                         │       Codex / Cursor (TODO)  │
                                         └──────────────────────────────┘
```

## Why

You're at your desk all day with Claude Code in a terminal. The moment
you step away — kitchen, commute, gym, sofa with the laptop closed —
you lose your agent. Phone Claude apps don't see your repo, your
sessions, your shell. SSH on a phone keyboard is miserable. agentphone
is the bridge: same agent, same sessions, same cwd, but driven from
the device in your pocket with proper UI for streaming text, code
blocks, tool calls, images and voice.

## Features

| | |
|---|---|
| 📱 token‑level streaming | every assistant chunk renders as it arrives (no waiting for full reply) |
| 🔧 inline tool approval | each tool call gets an approve / deny card; "本轮全 approve" for that tool name |
| ⚡ auto mode | one tap to bypass approvals entirely (mirrors desktop yolo / acceptEdits) |
| 🚀 max effort default | every turn ships with `effort: 'max'`; override per-machine via env |
| 📚 global session manager | drawer shows every Claude session across every cwd, labelable, deletable |
| 🔄 history replay | tap a session → last 30 messages auto‑load + auto‑scroll to bottom |
| 🖼️ image attachments | up to 4 images per prompt; multimodal Claude inputs |
| 🎤 voice input | Web Speech STT (zh-CN default) with visible diagnostics on failure |
| 🔊 voice output | Web Speech TTS — toggle per session |
| 🔁 reconnect-resilient | phone backgrounds / network drops don't kill the in-flight turn; replay on reconnect |
| 🪞 multi-device sync | same session opened on phone + iPad sees the same live stream |
| 🌐 multi-account | drives `~/.claude-accounts/<name>/` setups; auto-picks `cmax` if present |
| 🔑 stable bookmark | `/launch` always 302s to current token — bookmark once, never refresh |
| 🌑 PWA installable | manifest + SW + maskable icon → Add to Home Screen looks like a native app |
| 📋 remote phone log | every client log line lands at `/tmp/agentphone-phone.log` for tail-based debugging |

## Quick start

```bash
git clone https://github.com/CoolTao-Yang/agentphone.git
cd agentphone
npm install
npm start
```

The server prints two URLs:

```
═══════════════════════════════════════════════════
📱  agentphone server on :8765
📂  default cwd:    /home/yzt/test/agentphone
🤖  claude account: cmax (auto-detected)
🔑  token:          a8c4f97d92e0b1c4 (persisted)

Bookmark this on your phone (Chrome → Add to Home Screen).
It auto-redirects with the current token so it never goes stale:
   http://100.119.115.75:8765/launch

First-time / shareable direct link:
   http://100.119.115.75:8765/?token=a8c4f97d92e0b1c4
═══════════════════════════════════════════════════
```

Make sure Tailscale is running on both desktop and phone with the same
account. Open `/launch` in phone Chrome → Chrome menu → **Add to Home
Screen**. You now have an icon that opens the chat UI directly.

## Configuration

Environment variables (read on startup):

| var                 | default                    | meaning                                                  |
| ------------------- | -------------------------- | -------------------------------------------------------- |
| `PORT`              | `8765`                     | TCP port to listen on                                    |
| `HOST`              | `0.0.0.0`                  | bind address                                             |
| `PHONE_AGENT_TOKEN` | random 16-char hex (persisted) | URL token required to connect                        |
| `PHONE_AGENT_CWD`   | `process.cwd()`            | default working directory for new sessions               |
| `CLAUDE_CONFIG_DIR` | auto-detect from `~/.claude-accounts/` | which Claude account agentphone drives (see below) |

The token persists to `~/.config/agentphone/env` (`chmod 600`) on first
generation, so restarts reuse it — combined with `/launch`, the phone
bookmark never goes stale.

### Multi-account Claude setups

If you run multiple Claude accounts isolated via `CLAUDE_CONFIG_DIR`
(e.g. `~/.claude-accounts/cmax/`), agentphone auto-detects them on
startup, preferring `cmax` if present. To pin a specific account:

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/cpro1 npm start
```

The active account name shows as a chip in the PWA header. Sessions
are typically shared across accounts via `~/.claude-shared/projects/`,
so the drawer lists every session regardless of which account is
active. The account choice mainly affects usage billing and which
`.claude.json` / plugin set the agent loads.

## HTTPS (required for microphone)

Android Chrome (94+) requires a secure context for the Web Speech API.
Without it, the mic button will silently abort. To enable HTTPS via
Tailscale:

```powershell
# Windows PowerShell (host where Tailscale is installed)
tailscale serve --bg https / http://localhost:8765
```

Tailscale prints a `https://<host>.<tailnet>.ts.net/` URL with a real
Let's Encrypt cert. Use that on the phone instead of the raw IP.

If you see *HTTPS not enabled for tailnet* — Tailscale admin console →
DNS → toggle "Enable HTTPS".

## Auto-start (WSL / Linux)

```bash
./scripts/install-autostart.sh
```

Installs a systemd **user** unit that:
- starts at boot via `loginctl enable-linger`
- reads `~/.config/agentphone/env` (token, port, `CLAUDE_CONFIG_DIR`)
- restarts on crash

Manage with:

```bash
systemctl --user status   agentphone
systemctl --user stop     agentphone
systemctl --user disable  agentphone
journalctl --user -u agentphone -f
```

> WSL needs systemd enabled (`[boot] systemd=true` in `/etc/wsl.conf`,
> then `wsl --shutdown` from PowerShell once).

## Phone UI

```
┌─────────────────────────────────────────────────┐
│ ☰  agent​phone  cmax  · cwd     ●  ⚡  🔈  ⚙   │  header
├─────────────────────────────────────────────────┤
│                                                 │
│  你 ▶ 帮我看一下 main.ts                        │
│                                                 │
│  claude ◆                                       │  one header
│  好——我先打开它…                              │  per turn,
│                                                 │  multiple
│  ┌──────────────────────────────────────────┐   │  blocks stack
│  │ 🔧 Read main.ts                          │   │  beneath
│  │ ▾ approve / ✗ deny    [本轮全 approve]   │   │
│  └──────────────────────────────────────────┘   │  ← tool card
│                                                 │
│  claude ◆                                       │
│  这个文件做了三件事…                            │
│                                                 │
│ ────── done · 2.1s · 8 turns · $0.003 ──────── │
├─────────────────────────────────────────────────┤
│ 🎤  📷  [问 claude…]                       ↑    │  composer
└─────────────────────────────────────────────────┘
```

| button | meaning |
|---|---|
| ☰ | sessions drawer (list / new / rename / delete) |
| ⚡ | toggle auto mode — tool calls auto-approve |
| 🔈 → 🔊 | toggle TTS — read assistant replies aloud |
| ⚙ | toggle debug overlay (shows ws state, errors) |
| ↻ | (in drawer) reset to a new session |
| 🎤 | start STT — speak into input |
| 📷 | attach images — camera or gallery, up to 4 |
| ↑ | send (also Enter; Shift+Enter for newline) |
| ■ | interrupt the running turn |

## Architecture choices

- **TypeScript on both sides.** Shared `shared/types.ts` — the WS
  protocol has one source of truth, no client/server drift.
- **No frontend build step.** Single static dir, vanilla JS, marked +
  highlight.js from CDN, service worker caches the shell so subsequent
  opens are instant.
- **Agent abstraction.** `server/agents/types.ts` defines a small
  interface (`startTurn`, `listSessions`, `getSessionMessages`, …).
  `ClaudeAgent` implements it via `@anthropic-ai/claude-agent-sdk`;
  adding Codex/Cursor is a single new file in `server/agents/` plus
  one line in `registry.ts`.
- **`TurnRunner` decouples turn lifetime from WS lifetime.** The
  agent keeps running on the desktop even if the phone backgrounds —
  events flow into an in-memory buffer keyed to the current turn.
  Reconnects replay the buffer in `connected.activeTurn.events`.
- **Storage = whatever the agent already uses.** Claude Code already
  writes session jsonl to `~/.claude(-shared)/projects/<encoded-cwd>/`;
  agentphone reads those directly. Only user-supplied labels live in
  a small sidecar at `~/.config/agentphone/labels.json`.
- **Tool approval round-trips through WS.** SDK's `canUseTool`
  callback awaits the phone's `tool_response`. When `⚡ auto mode` is
  on, approvals are skipped server-side.
- **Stable bookmark.** Token persists to disk; `/launch` 302s to the
  current token. Phone bookmarks the launch URL once; rotations don't
  break it.

## Layout

```
.
├── package.json
├── tsconfig.json
├── shared/
│   └── types.ts                  protocol shared between server + browser
├── server/
│   ├── main.ts                   entry; token resolution; banner
│   ├── runner.ts                 TurnRunner (decoupled turn + replay buffer)
│   ├── ws.ts                     WebSocket handler + settings
│   ├── sessions.ts               REST: list / label / delete / messages / cwds
│   └── agents/
│       ├── types.ts              Agent interface (kind-agnostic)
│       ├── registry.ts           wire in concrete agents here
│       └── claude.ts             Claude Code SDK driver
├── static/
│   ├── index.html                PWA shell
│   ├── app.js                    client (chat, sessions, voice, images)
│   ├── style.css
│   ├── manifest.webmanifest
│   ├── sw.js                     service worker (shell cache)
│   └── icon.svg                  maskable PWA icon
└── scripts/
    ├── agentphone.service.template
    └── install-autostart.sh
```

## Build an APK (optional)

If you prefer a real installable Android app over the "Add to Home
Screen" PWA, `agentphone` ships a [Capacitor](https://capacitorjs.com/)
wrapper. The APK is a thin native shell whose WebView loads the
PWA from your local agentphone server (over Tailscale).

### Two ways to get an APK

**A. GitHub Actions (no local Android setup)**

Push to `main` (or trigger `Build Android APK` in the Actions tab) and
GitHub will build a debug APK and attach it as a workflow artifact.
Download, sideload onto your phone.

To override the baked-in server URL for one build (e.g. testing a
different Tailscale IP), use the workflow's `server_url` input.

**B. Local build via Android Studio**

```bash
# one-time on your dev machine
#   - install Android Studio (or Android SDK + JDK 17)
#   - accept SDK licences

cd agentphone
npx cap sync android         # copies static/ into the android project
npx cap open android         # opens the project in Android Studio
# then: Build → Build Bundle(s) / APK(s) → Build APK(s)
```

Or fully headless:

```bash
cd android
./gradlew assembleDebug
# APK ends up at android/app/build/outputs/apk/debug/app-debug.apk
```

### Install on phone

1. Enable **Developer options** → **USB debugging** on the phone
2. Plug into your computer
3. `adb install android/app/build/outputs/apk/debug/app-debug.apk`

Or just send the `.apk` file to the phone (Google Drive, email, file
share) and tap to install (you'll need to allow "Install unknown apps"
once for the file source).

### Change the baked-in server URL

The Tailscale URL is set in [`capacitor.config.ts`](capacitor.config.ts):

```ts
server: {
  url: process.env.AGENTPHONE_SERVER_URL || 'http://100.119.115.75:8765/launch',
  cleartext: true,
}
```

To rebuild with a different URL: edit the literal **or** set
`AGENTPHONE_SERVER_URL=...` before `npx cap sync android && cd android && ./gradlew assembleDebug`.

> v2 will read the server URL from a settings screen at runtime so
> you don't need to rebuild the APK when the IP changes.

## Roadmap

Concrete next steps, roughly priority-ordered:

1. **CodexAgent** — pty-wrap the Codex CLI to satisfy the existing
   `Agent` interface. About a day of work; the runner and UI need
   zero changes.
2. **Effort selector in UI** — header chip lets you flip between
   low/medium/high/max per session.
3. **Image rendering in history replay** — currently the
   `/api/sessions/:id/messages` endpoint strips images; preserve and
   render thumbnails.
4. **Notifications on long-running turn completion** — Web Push
   when the phone is backgrounded and a turn ends.
5. **Multi-turn-parallel** — TurnRunner is currently a singleton;
   support N runners keyed by session so two prompts can run at once.
6. **Server-side persistence of in-flight buffer** — survive a
   server crash mid-turn (today the in-memory buffer is lost on
   restart; Claude's own jsonl still has the canonical record).
7. **Capacitor APK wrap** — only when PWA hits a real limit
   (background tasks, share intents from other apps, lockscreen
   control); PWA does ~90% of the "feels like an app" today.

## License

MIT — see [LICENSE](LICENSE).
