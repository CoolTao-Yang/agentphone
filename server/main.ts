import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { mountWebSocket } from './ws.ts';
import { mountSessionApi } from './sessions.ts';
import { externalSessions } from './harness/registry.ts';
import { pushStore } from './store/push.ts';
import { vapidPublicKey } from './push.ts';
import { usageSummary } from './store/usage.ts';
import { getLatestApk, getCachedApkInfo, hasGhToken } from './apk-download.ts';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import QRCode from 'qrcode';

// Corp networks (ByteDance WSL behind Clash) reach api.github.com only
// via Clash on 127.0.0.1:7897. Node 24's built-in fetch (undici) ignores
// HTTPS_PROXY env on its own — we have to wire a dispatcher in.
//
// EnvHttpProxyAgent (undici ≥6.10) reads HTTPS_PROXY / HTTP_PROXY /
// NO_PROXY at request time. NO_PROXY in our env covers localhost / 10.x
// / 172.x / 192.168.x so local-only traffic (push to localhost, future
// internal callbacks) bypasses the proxy automatically.
//
// Opt-in by design: dev machines without the env vars run direct.
{
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`🌐  outbound HTTPS via proxy: ${proxyUrl} (NO_PROXY honored)`);
  }
}

// Token resolution order:
//   1. PHONE_AGENT_TOKEN env var (caller overrides everything)
//   2. PHONE_AGENT_TOKEN line in ~/.config/agentphone/env (persistent)
//   3. random — generated AND written back to the env file so the next
//      restart reuses it. This keeps the phone's bookmark URL stable.
const ENV_FILE = join(homedir(), '.config', 'agentphone', 'env');

function readTokenFromEnvFile(): string | null {
  try {
    const txt = readFileSync(ENV_FILE, 'utf-8');
    const m = txt.match(/^PHONE_AGENT_TOKEN=(.+)$/m);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function persistTokenToEnvFile(token: string): void {
  try {
    mkdirSync(dirname(ENV_FILE), { recursive: true });
    let content = '';
    try { content = readFileSync(ENV_FILE, 'utf-8'); } catch { /* new file */ }
    if (/^PHONE_AGENT_TOKEN=/m.test(content)) {
      content = content.replace(/^PHONE_AGENT_TOKEN=.*$/m, `PHONE_AGENT_TOKEN=${token}`);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `PHONE_AGENT_TOKEN=${token}\n`;
    }
    writeFileSync(ENV_FILE, content, 'utf-8');
    try { chmodSync(ENV_FILE, 0o600); } catch { /* best effort */ }
  } catch (e) {
    console.warn('warn: could not persist token to env file:', e);
  }
}

let TOKEN_SOURCE: 'env' | 'file' | 'generated' = 'env';
let TOKEN = process.env.PHONE_AGENT_TOKEN || '';
if (!TOKEN) {
  const fromFile = readTokenFromEnvFile();
  if (fromFile) {
    TOKEN = fromFile;
    TOKEN_SOURCE = 'file';
  } else {
    TOKEN = randomBytes(8).toString('hex');
    persistTokenToEnvFile(TOKEN);
    TOKEN_SOURCE = 'generated';
  }
}
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

// CORS for cross-origin REST. The APK loads its bundled index.html at
// http://localhost (Capacitor's default scheme), then hits this server at
// e.g. http://100.119.115.75:8765. Without permissive CORS, browsers
// (incl. WebView) block all those /api/* fetches. Token in the query
// string is the actual auth, so origin isn't a meaningful security
// boundary here — we mirror back whatever Origin came in. WebSocket
// handshake doesn't use CORS the same way and is fine.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin') || '*';
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', origin);
  c.res.headers.set('Vary', 'Origin');
  c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-token');
});
app.options('/api/*', (c) => {
  const origin = c.req.header('origin') || '*';
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-token',
      'Access-Control-Max-Age': '86400',
    },
  });
});

// #13: simple per-IP rate limit on REST + WS handshake. Bypassed for the
// static file path because we want PWA loads to be instant.
const rlBuckets = new Map<string, { count: number; resetAt: number }>();
const RL_WINDOW_MS = 60_000;
const RL_MAX = 240;  // 4/s sustained; bursts fine for normal use
app.use('/api/*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || (c.req as any).raw?.socket?.remoteAddress
    || 'unknown';
  const now = Date.now();
  const b = rlBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    rlBuckets.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
  } else {
    b.count++;
    if (b.count > RL_MAX) {
      return c.json({ error: 'rate limited' }, 429);
    }
  }
  return next();
});

// Start tracking external (CLI / cmax / bg) claude.exe processes so the WS
// can flag sessions as "another end is driving this".
externalSessions.start();

mountSessionApi(app, TOKEN);
mountWebSocket(app, upgradeWebSocket, { TOKEN, DEFAULT_CWD });

// Multi-account info (P1.2). Lists ~/.claude-accounts/* (the dirs cmax
// manages). Active = whatever CLAUDE_CONFIG_DIR points at right now. v1 is
// read-only — switching at runtime requires Agent SDK env support we
// don't yet have, so this just surfaces what's already configured.
app.get('/api/accounts', (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const accountsDir = join(homedir(), '.claude-accounts');
  const out: { name: string; path: string; active: boolean }[] = [];
  if (existsSync(accountsDir)) {
    try {
      for (const name of readdirSync(accountsDir)) {
        const path = join(accountsDir, name);
        const active = CLAUDE_CONFIG_DIR === path;
        out.push({ name, path, active });
      }
    } catch { /* ignore */ }
  }
  // Also surface the default ~/.claude if no accounts dir
  if (!out.length) {
    out.push({ name: '(default)', path: join(homedir(), '.claude'), active: true });
  }
  return c.json({ accounts: out, activePath: CLAUDE_CONFIG_DIR || null });
});

// Local usage telemetry summary (UX research). Token-gated; data is local
// only (~/.config/agentphone/usage.jsonl) and never leaves this machine.
app.get('/api/usage', async (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json(await usageSummary());
});

// ── HTTPS one-click setup ─────────────────────────────────────
// Lets the phone tell the server "please run `tailscale serve --bg
// https / http://localhost:<port>` for me so my Web Speech mic
// permission stops failing". Token-gated like the rest.
function execCmd(cmd: string, args: string[], timeoutMs = 15_000):
  Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ ok: false, stdout, stderr: e?.message || String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { p.kill('SIGTERM'); } catch {}
      resolve({ ok: false, stdout, stderr: stderr + '\n[timeout after ' + timeoutMs + 'ms]' });
    }, timeoutMs);
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + '\n' + (e?.message || String(e)) });
    });
  });
}

async function findTailscaleBin(): Promise<string | null> {
  // Try common locations: native WSL/Linux, then Windows-side via /mnt/c.
  const candidates = [
    'tailscale',
    '/mnt/c/Program Files/Tailscale/tailscale.exe',
    'tailscale.exe',
  ];
  for (const cand of candidates) {
    const r = await execCmd(cand, ['version'], 3_000);
    if (r.ok) return cand;
  }
  return null;
}

app.post('/api/setup-https', async (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const ts = await findTailscaleBin();
  if (!ts) {
    return c.json({
      ok: false,
      error: 'tailscale binary not found on this host. Run the command manually in PowerShell:\n  tailscale serve --bg https / http://localhost:' + PORT,
    }, 500);
  }

  const serveRes = await execCmd(ts, ['serve', '--bg', 'https', '/', `http://localhost:${PORT}`], 12_000);
  // Even if "serve" exits non-zero (e.g., funnel exists), try status to see what's actually configured.
  const statusRes = await execCmd(ts, ['status', '--json'], 5_000);
  if (!statusRes.ok) {
    return c.json({
      ok: false,
      error: 'tailscale status failed: ' + (statusRes.stderr || statusRes.stdout).slice(0, 500),
      serveStderr: serveRes.stderr.slice(0, 500),
    });
  }
  let dns: string | null = null;
  try {
    const j = JSON.parse(statusRes.stdout);
    dns = (j?.Self?.DNSName || '').replace(/\.$/, '') || null;
  } catch { /* fall through */ }
  if (!dns) {
    return c.json({
      ok: false,
      error: 'could not parse tailscale status output to find DNS name',
      serveStderr: serveRes.stderr.slice(0, 500),
    });
  }
  return c.json({
    ok: serveRes.ok,
    url: `https://${dns}/launch`,
    serveMessage: (serveRes.stdout + '\n' + serveRes.stderr).trim().slice(0, 500),
  });
});

// ── Web Push subscription API ────────────────────────────────
// Public-key fetch is token-gated like everything else. Subscribe persists
// the browser's PushSubscription so the server can fire turn_done
// notifications even when the PWA is closed.

app.get('/api/push/vapid', (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const pub = vapidPublicKey();
  if (!pub) return c.json({ error: 'VAPID keys not configured' }, 503);
  return c.json({ publicKey: pub });
});

app.post('/api/push/subscribe', async (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad json' }, 400); }
  const sub = body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    return c.json({ error: 'malformed subscription' }, 400);
  }
  await pushStore.upsert({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    expirationTime: sub.expirationTime ?? null,
    deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel.slice(0, 80) : undefined,
    createdAt: Date.now(),
  });
  const total = await pushStore.count();
  console.log(`[push] subscribed endpoint=${String(sub.endpoint).slice(0, 60)}... total=${total}`);
  return c.json({ ok: true, total });
});

app.delete('/api/push/subscribe', async (c) => {
  if (c.req.query('token') !== TOKEN && c.req.header('x-token') !== TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const endpoint = c.req.query('endpoint');
  if (!endpoint) return c.json({ error: 'missing endpoint' }, 400);
  await pushStore.delete(endpoint);
  return c.json({ ok: true });
});

// Server-side QR for the /launch URL. Useful for the APK bootstrap so the
// user can either scan from another phone OR see a "scan me" graphic right
// in the manual-URL form.
app.get('/api/launch-qr', async (c) => {
  // Public on purpose — the QR encodes a URL that already includes the token.
  const ip = c.req.query('ip');
  if (!ip) return c.json({ error: 'missing ?ip=<tailscale-ip>' }, 400);
  const url = `http://${ip}:${PORT}/launch`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
    return c.json({ url, dataUrl });
  } catch (e: any) {
    return c.json({ error: e?.message || 'qr generation failed' }, 500);
  }
});

// Stable bookmark target — phone bookmarks this single URL forever,
// and we 302 it to the chat UI with the current token attached.
// Open access on purpose: anyone who can reach the server (i.e. is on
// your tailnet) is trusted enough to receive the token.
app.get('/launch', (c) => c.redirect(`/?token=${encodeURIComponent(TOKEN)}`, 302));

// ── APK self-distribution ─────────────────────────────────────────
// /api/apk-info: JSON metadata for the latest successful build.
// /api/download-apk: streams the actual .apk binary.
//
// Public on purpose — anyone on the tailnet can install. The first-run
// bootstrap UI also surfaces /api/download-apk so even a brand-new
// phone (no APK installed yet) can grab one by browsing the server's
// `/?token=` link from any browser, hitting "下载 APK", and installing.
app.get('/api/apk-info', async (c) => {
  if (!hasGhToken()) {
    return c.json({
      error: 'GH token 缺失 — 服务端找不到 ~/.config/gh/hosts.yml, 也没有 GH_TOKEN 环境变量',
    }, 503);
  }
  try {
    const info = await getLatestApk();
    return c.json({
      runNumber: info.runNumber,
      sha: info.shortSha,
      commitMessage: info.commitMessage,
      builtAt: info.builtAt,
      sizeMB: +(info.size / 1024 / 1024).toFixed(2),
      downloadUrl: '/api/download-apk',
    });
  } catch (e: any) {
    return c.json({ error: e?.message || 'failed to fetch APK info' }, 502);
  }
});

app.get('/api/download-apk', async (c) => {
  if (!hasGhToken()) {
    return c.text(
      'GH token 缺失. 服务端启动用户跑一下 `gh auth login` 或 export GH_TOKEN=...',
      503,
    );
  }
  try {
    const info = await getLatestApk();
    // The APK is small (~10-20MB) so loading into memory is fine and
    // gives Hono an honest Content-Length out of the box.
    const buf = readFileSync(info.apkPath);
    const filename = `agentphone-${info.shortSha}.apk`;
    c.header('Content-Type', 'application/vnd.android.package-archive');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Content-Length', String(buf.length));
    c.header('X-Agentphone-Run', String(info.runNumber));
    c.header('X-Agentphone-Sha', info.shortSha);
    return c.body(buf);
  } catch (e: any) {
    return c.text('APK download failed: ' + (e?.message || e), 502);
  }
});

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

  const tokenNote =
    TOKEN_SOURCE === 'env' ? '(from env)' :
    TOKEN_SOURCE === 'file' ? `(persisted at ${ENV_FILE})` :
    `(generated → saved to ${ENV_FILE})`;

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
  console.log(`🔑  token:          ${TOKEN} ${tokenNote}`);
  console.log('');
  const ips = tsIPs.length ? tsIPs : ['<your-tailscale-ip>'];
  console.log('Bookmark this on your phone (Chrome → Add to Home Screen).');
  console.log('It auto-redirects with the current token so it never goes stale:');
  for (const ip of ips) console.log(`   http://${ip}:${info.port}/launch`);
  console.log('');
  console.log('First-time / shareable direct link:');
  for (const ip of ips) console.log(`   http://${ip}:${info.port}/?token=${TOKEN}`);
  console.log('');
  // APK self-distribution. Print a direct download URL so the user can
  // browse to it from any phone browser and install without going to
  // github.com/CoolTao-Yang/agentphone/actions. Don't crash if GH token
  // isn't available — just hide the line.
  if (hasGhToken()) {
    console.log('📦  Install / update the APK (auto-fetches latest CI build):');
    for (const ip of ips) console.log(`   http://${ip}:${info.port}/api/download-apk`);
    console.log('');
    // Warm the cache in the background so the first hit is instant. Errors
    // are surfaced when the endpoint is actually called, not here.
    getLatestApk()
      .then((apk) => console.log(`📦  cached APK: build #${apk.runNumber} · ${apk.shortSha} · ${(apk.size / 1024 / 1024).toFixed(1)}MB`))
      .catch((e) => console.warn(`📦  APK cache warm failed: ${e?.message || e}`));
  } else {
    console.log('📦  APK auto-distribution disabled — run `gh auth login` to enable /api/download-apk');
    console.log('');
  }
  // Phone-scannable QR. v33 was just the /launch URL — APKs that scanned
  // it still needed a separate manual token entry because /launch's job
  // was to 302 with the token. With the no-redirect rework the APK
  // bundles its own UI and just needs (baseURL, token) to start talking
  // to us, so encode BOTH in one shot:
  //     http://<ip>:8765/?token=<TOKEN>
  // Scanning that lets the APK auto-fill BOTH config values in one tap.
  //
  // Also drop a PNG copy to /tmp so users can `xdg-open /tmp/agentphone-qr.png`
  // (or pull it across `scp`) if they can't easily read the systemd journal.
  if (tsIPs.length > 0) {
    const primary = `http://${tsIPs[0]}:${info.port}/?token=${TOKEN}`;
    const pngPath = '/tmp/agentphone-qr.png';
    QRCode.toString(primary, { type: 'terminal', small: true }, (err, qr) => {
      if (err) {
        console.log('═══════════════════════════════════════════════════');
        return;
      }
      console.log(`📱 phone QR — APK 内 "📷 扫码" 一键填好 (URL + token):`);
      console.log(qr.split('\n').map((l) => '  ' + l).join('\n'));
      console.log(`    QR PNG also at ${pngPath}`);
      console.log('═══════════════════════════════════════════════════');
    });
    QRCode.toFile(pngPath, primary, { width: 480, margin: 2 }).catch(() => {
      /* ignore PNG write failures — terminal QR is the primary surface */
    });
  } else {
    console.log('═══════════════════════════════════════════════════');
  }
});
injectWebSocket(server);
