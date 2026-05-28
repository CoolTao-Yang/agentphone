// REST API for sessions + label storage.
// All "where do the jsonl files live" logic is in the per-agent
// implementation; this file is a thin façade that merges results from
// every registered agent and overlays a sidecar label file.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono, Context } from 'hono';
import type { SessionMessagesResponse, SessionSummary } from '../shared/types.ts';
import { agents, ownerOfSession } from './agents/registry.ts';
import { activeSessionIds } from './ws.ts';
import { externalSessions } from './external-sessions.ts';

const CONFIG_DIR  = join(homedir(), '.config', 'agentphone');
const LABELS_PATH = join(CONFIG_DIR, 'labels.json');
const LEGACY_LABELS_PATH = join(homedir(), '.config', 'claude4phone', 'labels.json');

type Labels = Record<string, { name: string }>;

async function readLabels(): Promise<Labels> {
  for (const p of [LABELS_PATH, LEGACY_LABELS_PATH]) {
    try { return JSON.parse(await readFile(p, 'utf-8')) as Labels; } catch { /* try next */ }
  }
  return {};
}

async function writeLabels(labels: Labels): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  const labels = await readLabels();
  const running = activeSessionIds();
  const all: SessionSummary[] = [];
  for (const a of agents) {
    const sessions = await a.listSessions();
    for (const s of sessions) {
      s.name = labels[s.sessionId]?.name ?? null;
      if (running.has(s.sessionId)) s.running = true;
      const ext = externalSessions.get(s.sessionId);
      if (ext) {
        s.external = { pid: ext.pid, account: ext.account, kind: ext.kind, status: ext.status };
      }
      all.push(s);
    }
  }
  return all.sort((a, b) => {
    // Active (any kind) float to top: external busy > our running > external idle > everything else.
    const aActive = !!a.running || a.external?.status === 'busy';
    const bActive = !!b.running || b.external?.status === 'busy';
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.lastUsed - a.lastUsed;
  });
}

export async function setSessionLabel(sessionId: string, name: string | null): Promise<void> {
  const labels = await readLabels();
  if (!name) delete labels[sessionId];
  else labels[sessionId] = { name: name.slice(0, 80) };
  await writeLabels(labels);
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const owner = await ownerOfSession(sessionId);
  if (!owner) return false;
  const removed = await owner.deleteSession(sessionId);
  if (removed) {
    const labels = await readLabels();
    delete labels[sessionId];
    await writeLabels(labels);
  }
  return removed;
}

export async function recentCwds(): Promise<string[]> {
  const sessions = await listAllSessions();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    if (seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    out.push(s.cwd);
    if (out.length >= 12) break;
  }
  return out;
}

async function getSessionMessages(sessionId: string, limit: number): Promise<SessionMessagesResponse | null> {
  const owner = await ownerOfSession(sessionId);
  if (!owner) return null;
  return owner.getSessionMessages(sessionId, limit);
}

function authed(c: Context, token: string): boolean {
  return (c.req.query('token') || c.req.header('x-token')) === token;
}

export function mountSessionApi(app: Hono, token: string): void {
  app.get('/api/sessions', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await listAllSessions());
  });

  app.patch('/api/sessions/:id', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty body ok */ }
    await setSessionLabel(id, typeof body?.name === 'string' ? body.name : null);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    return c.json({ ok: await deleteSession(id) });
  });

  app.get('/api/sessions/:id/messages', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') || 30);
    const r = await getSessionMessages(id, isNaN(limit) ? 30 : limit);
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });

  app.get('/api/recent-cwds', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ cwds: await recentCwds() });
  });
}
