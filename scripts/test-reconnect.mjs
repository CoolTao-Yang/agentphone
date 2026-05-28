// End-to-end reconnect test.
// Verifies:
//   1. Initial WS connection → server emits 'connected'
//   2. Server-driven heartbeat ping (~25s cadence)
//   3. Client→server pong is accepted (no premature close)
//   4. Clean disconnect → reconnect produces another 'connected' frame
//   5. Disconnect MID-TURN → reconnect's 'connected' replays activeTurn events
//
// Run:  PHONE_AGENT_TOKEN=$(grep TOKEN ~/.config/agentphone/env | cut -d= -f2) \
//         node scripts/test-reconnect.mjs
//
// Total runtime ~60s (heartbeat test is the long pole).

import { WebSocket } from 'ws';

const TOKEN = process.env.PHONE_AGENT_TOKEN || '';
const URL = `ws://localhost:8765/ws?token=${encodeURIComponent(TOKEN)}`;
if (!TOKEN) { console.error('missing PHONE_AGENT_TOKEN'); process.exit(2); }

function timeout(ms, label) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms));
}

function awaitMessage(ws, predicate, label, ms = 30_000) {
  return Promise.race([
    new Promise((resolve) => {
      const onMsg = (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (predicate(m)) { ws.off('message', onMsg); resolve(m); }
        } catch {}
      };
      ws.on('message', onMsg);
    }),
    timeout(ms, label),
  ]);
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const onErr = (e) => reject(new Error(`${label} ws error: ${e.message}`));
    ws.once('open', () => {
      ws.off('error', onErr);
      resolve(ws);
    });
    ws.once('error', onErr);
    setTimeout(() => reject(new Error(`${label} ws never opened`)), 5000);
  });
}

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

async function test() {
  // ── 1. initial connect ──────────────────────────────────────
  console.log(`[${elapsed()}] test 1: initial connect`);
  let ws = await connect('1');
  const connected1 = await awaitMessage(ws, m => m.type === 'connected', 'connected', 5_000);
  console.log(`  ✓ got 'connected' · account=${connected1.claudeAccount} · cwd=${connected1.currentCwd}`);

  // ── 2. server-driven heartbeat ──────────────────────────────
  console.log(`[${elapsed()}] test 2: wait for first ping (cadence 25s)`);
  const ping = await awaitMessage(ws, m => m.type === 'ping', 'first ping', 35_000);
  console.log(`  ✓ got 'ping' at ${elapsed()} · server ts ${ping.ts}`);
  ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
  console.log(`  → sent 'pong'`);
  // wait 5s to confirm server is happy
  await new Promise(r => setTimeout(r, 5_000));
  if (ws.readyState !== WebSocket.OPEN) throw new Error('ws closed after pong');
  console.log(`  ✓ ws still OPEN 5s after pong`);

  // ── 3. clean reconnect ──────────────────────────────────────
  console.log(`[${elapsed()}] test 3: clean disconnect + reconnect`);
  ws.close();
  await new Promise(r => setTimeout(r, 1_000));
  ws = await connect('3');
  const connected2 = await awaitMessage(ws, m => m.type === 'connected', 'reconnected', 5_000);
  console.log(`  ✓ reconnected · activeTurn=${connected2.activeTurn ? 'present' : 'none'}`);

  // ── 4. mid-turn disconnect + replay + seq numbering ─────────
  console.log(`[${elapsed()}] test 4: mid-turn disconnect → reconnect → activeTurn replay + seq`);
  ws.send(JSON.stringify({ type: 'prompt', text: '回一个字: pong' }));
  console.log(`  → sent tiny prompt`);
  const firstEvt = await awaitMessage(ws, m => m.type === 'agent_event', 'first event', 30_000);
  console.log(`  ✓ first agent_event arrived (kind=${firstEvt.event?.kind || '?'})`);
  if (typeof firstEvt.seq !== 'number') {
    console.log(`  ✗ agent_event has no seq!`); process.exit(1);
  }
  if (!firstEvt.turnId) {
    console.log(`  ✗ agent_event has no turnId!`); process.exit(1);
  }
  console.log(`  ✓ event carries seq=${firstEvt.seq} turnId=${firstEvt.turnId.slice(0,8)}`);
  const firstTurnId = firstEvt.turnId;
  // Disconnect immediately — turn is still running on server.
  ws.close();
  console.log(`  → disconnected at ${elapsed()}`);
  await new Promise(r => setTimeout(r, 2_500));

  ws = await connect('4-reconnect');
  const connected3 = await awaitMessage(ws, m => m.type === 'connected', 'reconnected-3', 5_000);
  if (!connected3.activeTurn) {
    console.log(`  ✗ no activeTurn on reconnected frame!`);
    process.exit(1);
  }
  const evs = connected3.activeTurn.events || [];
  if (connected3.activeTurn.turnId !== firstTurnId) {
    console.log(`  ✗ activeTurn.turnId changed mid-stream (${firstTurnId.slice(0,8)} → ${connected3.activeTurn.turnId.slice(0,8)})`);
    process.exit(1);
  }
  // Verify each event has a seq, monotonically increasing
  let prev = -1;
  for (const se of evs) {
    if (typeof se?.seq !== 'number') { console.log('  ✗ event missing seq:', se); process.exit(1); }
    if (se.seq <= prev) { console.log(`  ✗ seq not monotonic: ${prev} → ${se.seq}`); process.exit(1); }
    prev = se.seq;
  }
  console.log(`  ✓ activeTurn replay: ${evs.length} events, seq 0..${prev}, turnId stable, done=${connected3.activeTurn.done}`);

  // Wait for turn to finish (or 20s)
  try {
    const td = await awaitMessage(ws, m => m.type === 'turn_done' || (m.type === 'agent_event' && m.event?.kind === 'result'), 'turn end', 30_000);
    console.log(`  ✓ turn ended (${td.type})`);
  } catch {
    console.log(`  (turn still running at ${elapsed()}, that's OK)`);
  }

  ws.close();
  console.log(`\n[${elapsed()}] ✅ ALL PASSED`);
  process.exit(0);
}

test().catch(e => {
  console.error(`\n[${elapsed()}] ❌ FAIL: ${e.message}`);
  process.exit(1);
});
