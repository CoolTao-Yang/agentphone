// Session listing + user-provided label storage.
// Source of truth for sessions is Claude's own ~/.claude/projects/<encoded-cwd>/sessions/<uuid>.jsonl.
// We add a sidecar labels file at ~/.config/claude4phone/labels.json that only stores user-chosen names.

import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono, Context } from 'hono';
import type { SessionSummary } from '../shared/types.ts';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const CONFIG_DIR    = join(homedir(), '.config', 'claude4phone');
const LABELS_PATH   = join(CONFIG_DIR, 'labels.json');

type Labels = Record<string, { name: string }>;

async function readLabels(): Promise<Labels> {
  try {
    return JSON.parse(await readFile(LABELS_PATH, 'utf-8')) as Labels;
  } catch {
    return {};
  }
}

async function writeLabels(labels: Labels): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
}

// Claude encodes a cwd path by replacing `/` with `-`. Decoding is lossy for
// paths containing hyphens but works for typical /home/user/foo trees.
function decodeProjectFolder(folder: string): string {
  return folder.replace(/-/g, '/');
}

// Read first N lines of a session's jsonl to derive preview, turn count, and cwd
// (most session files start with a system event that includes cwd).
async function summarizeJsonl(path: string): Promise<{ preview: string; turns: number; cwd?: string }> {
  let preview = '';
  let turns = 0;
  let cwd: string | undefined;
  try {
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && i < 200; i++) {
      const line = lines[i];
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof obj?.cwd === 'string') cwd = obj.cwd;
      if (obj?.type === 'assistant') turns++;
      if (!preview && obj?.type === 'user' && obj?.message?.content) {
        const c = obj.message.content;
        if (typeof c === 'string') preview = c;
        else if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              preview = block.text; break;
            }
            if (typeof block === 'string') { preview = block; break; }
          }
        }
      }
    }
  } catch { /* ignore */ }
  preview = (preview || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return { preview, turns, cwd };
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!existsSync(PROJECTS_ROOT)) return [];
  const labels = await readLabels();
  const projDirs = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  const out: SessionSummary[] = [];

  for (const proj of projDirs) {
    if (!proj.isDirectory() && !proj.isSymbolicLink()) continue;
    // Session files live directly under the project folder as <uuid>.jsonl.
    const projDir = join(PROJECTS_ROOT, proj.name);

    let files: string[];
    try {
      files = await readdir(projDir);
    } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -6);
      const full = join(projDir, f);
      let st;
      try { st = await stat(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.size === 0) continue;

      const { preview, turns, cwd } = await summarizeJsonl(full);
      out.push({
        sessionId,
        cwd: cwd ?? decodeProjectFolder(proj.name),
        name: labels[sessionId]?.name ?? null,
        preview: preview || '(空)',
        lastUsed: st.mtimeMs,
        turns,
      });
    }
  }

  out.sort((a, b) => b.lastUsed - a.lastUsed);
  return out;
}

export async function setSessionLabel(sessionId: string, name: string | null): Promise<void> {
  const labels = await readLabels();
  if (!name) {
    delete labels[sessionId];
  } else {
    labels[sessionId] = { name: name.slice(0, 80) };
  }
  await writeLabels(labels);
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  if (!existsSync(PROJECTS_ROOT)) return false;
  const projDirs = await readdir(PROJECTS_ROOT);
  for (const proj of projDirs) {
    const candidate = join(PROJECTS_ROOT, proj, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      try { await unlink(candidate); } catch { return false; }
      const labels = await readLabels();
      delete labels[sessionId];
      await writeLabels(labels);
      return true;
    }
  }
  return false;
}

export async function recentCwds(): Promise<string[]> {
  const sessions = await listSessions();
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

function authed(c: Context, token: string): boolean {
  return (c.req.query('token') || c.req.header('x-token')) === token;
}

export function mountSessionApi(app: Hono, token: string): void {
  app.get('/api/sessions', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await listSessions());
  });

  app.patch('/api/sessions/:id', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    let body: any = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    await setSessionLabel(id, typeof body?.name === 'string' ? body.name : null);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    return c.json({ ok: await deleteSession(id) });
  });

  app.get('/api/recent-cwds', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ cwds: await recentCwds() });
  });
}
