import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
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
  console.log('═══════════════════════════════════════════════════');
  console.log(`📱  agentphone server on :${info.port}`);
  console.log(`📂  default cwd: ${DEFAULT_CWD}`);
  console.log(`🔑  token:       ${TOKEN}`);
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
