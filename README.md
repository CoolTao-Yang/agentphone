# agentphone

Drive [Claude Code](https://claude.com/claude-code) from your phone over Tailscale.

A small Node + TypeScript server that runs alongside your Claude Code CLI on a
desktop / WSL host and exposes a mobile‑first PWA. The phone connects through
Tailscale (no public exposure) and gets:

- token‑level streaming markdown rendering (no waiting for the whole reply)
- in‑line **approve / deny** for tool calls, with an "approve rest of turn" shortcut
- multi‑session management — see every Claude session on this machine across
  every project, label them, jump between them
- Web Speech voice input + output (Chinese / English STT, system TTS)
- token‑gated WebSocket auth; URL bookmarked on phone

## How it works

```
[phone PWA]
    │  WebSocket   (token in URL ?token=…)
    ▼
[Node + Hono server]
    ├── /               static PWA shell
    ├── /ws             chat stream (assistant deltas + tool round‑trip)
    ├── /api/sessions   list / label / delete sessions across all cwds
    └── /api/recent-cwds  cwd suggestions when creating a new session
       │
       └── @anthropic-ai/claude-agent-sdk
              · includePartialMessages: true   (token streaming)
              · canUseTool: callback           (approval round‑trip)
              · cwd: per‑session              (multi‑project switch)
```

Tailscale provides the encrypted device‑to‑device tunnel. The server binds on
`0.0.0.0:8765`; phone reaches it via the host's Tailscale IP. No port forwards
on the home router and no public HTTPS cert needed (until you want microphone
access — see below).

## Install + run

```bash
git clone https://github.com/<you>/agentphone.git
cd agentphone
npm install
npm start
```

The server prints something like:

```
═══════════════════════════════════════════════════
📱  agentphone server on :8765
📂  default cwd: /home/yzt/test/agentphone
🔑  token:       a8c4f97d92e0b1c4

Open on phone (Chrome → Add to Home Screen):
   http://100.119.115.75:8765/?token=a8c4f97d92e0b1c4
═══════════════════════════════════════════════════
```

Open that URL in Chrome on the phone (with Tailscale running on the phone).
You should see the chat UI. Send a message; you're talking to the Claude Code
SDK running on this machine.

To "install" as an app: Chrome menu → **Add to Home Screen**. Manifest +
service worker are in place, so it becomes a standalone icon.

## Configuration

Environment variables (read on startup):

| var                 | default            | meaning                                       |
| ------------------- | ------------------ | --------------------------------------------- |
| `PORT`              | `8765`             | TCP port to listen on                         |
| `HOST`              | `0.0.0.0`          | bind address                                  |
| `PHONE_AGENT_TOKEN` | random 16‑char hex | URL token required to connect                 |
| `PHONE_AGENT_CWD`   | `process.cwd()`    | default working directory for new sessions    |
| `CLAUDE_CONFIG_DIR` | unset → `~/.claude/` | which Claude account to drive (see below)  |

### Multi-account Claude setups

If you run multiple Claude accounts isolated via `CLAUDE_CONFIG_DIR` (e.g.,
`~/.claude-accounts/<name>/`), set it before starting:

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/cmax npm start
```

The server prints which account it's driving at startup, and the phone PWA
shows a small badge next to the brand:

```
agent​phone  [cmax]   · /home/yzt/test/foo
```

Sessions are usually shared across accounts via `~/.claude-shared/projects/`,
so the drawer lists everything regardless of which account is active. The
account choice mostly affects usage billing and which `.claude.json` /
plugin set the agent loads.

When installed via `install-autostart.sh`, the env file at
`~/.config/agentphone/env` auto-defaults to the first account it finds
under `~/.claude-accounts/` (prefers `cmax` if present).

Pin a token (so the bookmark stays stable across restarts):

```bash
PHONE_AGENT_TOKEN=my-secret-token npm start
```

## HTTPS (required for microphone on Android Chrome)

Web Speech API requires a secure context. On the host, run:

```bash
tailscale serve --bg https / http://localhost:8765
```

Tailscale prints a `https://<host>.<tailnet>.ts.net/` URL with a real
Let's Encrypt cert. Use that URL on the phone instead of the raw IP.

Older Tailscale versions: `tailscale serve --bg --https=443 http://localhost:8765`.

If you see *HTTPS not enabled for tailnet* — go to the Tailscale admin
console → DNS → enable HTTPS.

## Auto‑start (WSL / Linux)

```bash
./scripts/install-autostart.sh
```

Installs a systemd **user** unit that:

- starts at boot via `loginctl enable-linger`
- reads `~/.config/agentphone/env` for `PHONE_AGENT_TOKEN` + `PORT`
- restarts on crash

Manage with:

```bash
systemctl --user status   agentphone
systemctl --user stop     agentphone
systemctl --user disable  agentphone
journalctl --user -u agentphone -f
```

> WSL note: the unit needs systemd enabled in WSL (`[boot] systemd=true` in
> `/etc/wsl.conf`, then `wsl --shutdown` from PowerShell once).

## Sessions

Sessions are persisted by Claude itself at
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. agentphone only adds a
sidecar of user‑provided **labels** at `~/.config/agentphone/labels.json`:

```json
{
  "90ec5d61-38e7-4da1-b2cc-51d500b0eeb1": { "name": "改 main.ts" }
}
```

The PWA drawer (☰) lists every session across every cwd, with timestamp,
turn count, and a one‑line preview lifted from the first user message.

## Architecture choices

- **TypeScript on both sides.** Server and browser share `shared/types.ts`,
  so the WebSocket protocol has a single source of truth. Matches the
  language of Claude Code itself.
- **No frontend build.** Single static dir — vanilla JS, no Vite. `marked` +
  `highlight.js` from CDN; the service worker caches them after first load
  so subsequent opens are instant and work offline (the WebSocket of
  course still needs network).
- **No backend persistence beyond labels.** Sessions live where Claude
  already puts them; we don't duplicate that storage.
- **Tool approval round‑trips through WebSocket.** The SDK's `canUseTool`
  callback blocks until the phone sends `tool_response`. There's an
  "approve rest of turn for this tool name" escape hatch for chatty
  sessions.

## Layout

```
.
├── package.json
├── tsconfig.json
├── shared/
│   └── types.ts                  protocol shared between server + browser
├── server/
│   ├── main.ts                   entry, route mounting, listener
│   ├── sessions.ts               REST: list / label / delete / recent‑cwds
│   └── ws.ts                     WebSocket handler + agent runner
├── static/
│   ├── index.html                PWA shell
│   ├── app.js                    client app (chat, sessions, voice)
│   ├── style.css
│   ├── manifest.webmanifest
│   ├── sw.js                     service worker (caches shell)
│   └── icon.svg
└── scripts/
    ├── agentphone.service.template
    └── install-autostart.sh
```

## License

MIT — see [LICENSE](LICENSE).
