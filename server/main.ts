import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { mountWebSocket } from './ws.ts';
import { mountSessionApi } from './sessions.ts';

const TOKEN = process.env.PHONE_AGENT_TOKEN || randomBytes(8).toString('hex');
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_CWD = process.env.PHONE_AGENT_CWD || process.cwd();

// Claude is account-scoped via CLAUDE_CONFIG_DIR. The SDK spawns the claude
// binary which inherits this from our environment, so we just need to make
// sure it's set sensibly before any SDK call. Auto-detection: if not set,
// pick the first account under ~/.claude-accounts/, preferring "cmax".
let CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || '';
let CLAUDE_CONFIG_DIR_AUTODETECTED = false;
if (!CLAUDE_CONFIG_DIR) {
  const accountsRoot = join(homedir(), '.claude-accounts');
  if (existsSync(accountsRoot)) {
    try {
      const entries = readdirSync(accountsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const picked = entries.includes('cmax') ? 'cmax' : entries[0];
      if (picked) {
        CLAUDE_CONFIG_DIR = join(accountsRoot, picked);
        process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
        CLAUDE_CONFIG_DIR_AUTODETECTED = true;
      }
    } catch { /* fall through to default */ }
  }
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

mountSessionApi(app, TOKEN);
mountWebSocket(app, upgradeWebSocket, { TOKEN, DEFAULT_CWD });

app.use('/*', serveStatic({ root: './static' }));

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const tsIPs: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && /^100\./.test(i.address)) tsIPs.push(i.address);
    }
  }
  const account = CLAUDE_CONFIG_DIR
    ? CLAUDE_CONFIG_DIR.replace(/\/+$/, '').split('/').pop() || '(custom)'
    : '(default ~/.claude/)';

  console.log('═══════════════════════════════════════════════════');
  console.log(`📱  agentphone server on :${info.port}`);
  console.log(`📂  default cwd:    ${DEFAULT_CWD}`);
  console.log(`🤖  claude account: ${account}${CLAUDE_CONFIG_DIR_AUTODETECTED ? ' (auto-detected)' : ''}`);
  if (CLAUDE_CONFIG_DIR) {
    console.log(`    └── CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`);
    if (CLAUDE_CONFIG_DIR_AUTODETECTED) {
      console.log(`        (override with: export CLAUDE_CONFIG_DIR=~/.claude-accounts/<name>)`);
    }
  } else {
    console.log(`    ⚠ no accounts found under ~/.claude-accounts/ — using default ~/.claude/`);
  }
  console.log(`🔑  token:          ${TOKEN}`);
  console.log('');
  console.log('Open on phone (Chrome → Add to Home Screen):');
  if (tsIPs.length) {
    for (const ip of tsIPs) console.log(`   http://${ip}:${info.port}/?token=${TOKEN}`);
  } else {
    console.log(`   http://<your-tailscale-ip>:${info.port}/?token=${TOKEN}`);
  }
  console.log('═══════════════════════════════════════════════════');
});
injectWebSocket(server);
