// Session listing + label storage + history materialization.
//
// Source of truth for session data is Claude's own jsonl files. We scan BOTH:
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl          (older / fallback)
//   ~/.claude-shared/projects/<encoded-cwd>/<uuid>.jsonl   (current)
// and dedupe by sessionId (keep whichever has the newer mtime).
//
// We add a sidecar of user-provided labels at ~/.config/agentphone/labels.json.

import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono, Context } from 'hono';
import type { HistoryMessage, SessionMessagesResponse, SessionSummary } from '../shared/types.ts';

const HOME = homedir();
const PROJECT_ROOTS = [
  join(HOME, '.claude', 'projects'),
  join(HOME, '.claude-shared', 'projects'),
];
const CONFIG_DIR  = join(HOME, '.config', 'agentphone');
const LABELS_PATH = join(CONFIG_DIR, 'labels.json');
// Fall back to legacy claude4phone config dir if the new one doesn't exist yet.
const LEGACY_LABELS_PATH = join(HOME, '.config', 'claude4phone', 'labels.json');

type Labels = Record<string, { name: string }>;

async function readLabels(): Promise<Labels> {
  for (const p of [LABELS_PATH, LEGACY_LABELS_PATH]) {
    try {
      return JSON.parse(await readFile(p, 'utf-8')) as Labels;
    } catch { /* try next */ }
  }
  return {};
}

async function writeLabels(labels: Labels): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
}

function decodeProjectFolder(folder: string): string {
  return folder.replace(/-/g, '/');
}

// Strip system wrappers that Claude Code injects around slash commands /
// /command output so we keep only what the user actually typed.
const CAVEAT_RX = /<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g;
const COMMAND_RX = /<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
function cleanUserText(s: string): string {
  if (!s) return '';
  return s.replace(CAVEAT_RX, '').replace(COMMAND_RX, '').trim();
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === 'string') parts.push(b);
      else if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') {
        parts.push((b as any).text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function stringifyToolResultContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x: any) => (typeof x?.text === 'string' ? x.text : JSON.stringify(x)))
      .join('\n');
  }
  return JSON.stringify(c);
}

async function summarizeJsonl(path: string): Promise<{ preview: string; turns: number; cwd?: string }> {
  let preview = '';
  let turns = 0;
  let cwd: string | undefined;
  try {
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && i < 400; i++) {
      const line = lines[i];
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof obj?.cwd === 'string') cwd = obj.cwd;
      if (obj?.type === 'assistant') turns++;
      if (!preview && obj?.type === 'user' && obj?.message?.content) {
        const raw = blockText(obj.message.content);
        const cleaned = cleanUserText(raw).replace(/\s+/g, ' ').trim();
        if (cleaned.length >= 2) preview = cleaned;
      }
    }
  } catch { /* ignore */ }
  return { preview: preview.slice(0, 120) || '(空)', turns, cwd };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const labels = await readLabels();
  // Map sessionId → best candidate so far (newer wins).
  const best = new Map<string, SessionSummary>();

  for (const root of PROJECT_ROOTS) {
    if (!existsSync(root)) continue;
    let projs;
    try { projs = await readdir(root, { withFileTypes: true }); } catch { continue; }

    for (const proj of projs) {
      if (!proj.isDirectory() && !proj.isSymbolicLink()) continue;
      const projDir = join(root, proj.name);
      let files: string[];
      try { files = await readdir(projDir); } catch { continue; }

      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.slice(0, -6);
        const full = join(projDir, f);
        let st;
        try { st = await stat(full); } catch { continue; }
        if (!st.isFile() || st.size < 200) continue;

        const existing = best.get(sessionId);
        if (existing && existing.lastUsed >= st.mtimeMs) continue;

        const { preview, turns, cwd } = await summarizeJsonl(full);
        best.set(sessionId, {
          sessionId,
          cwd: cwd ?? decodeProjectFolder(proj.name),
          name: labels[sessionId]?.name ?? null,
          preview,
          lastUsed: st.mtimeMs,
          turns,
        });
      }
    }
  }

  return [...best.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

export async function setSessionLabel(sessionId: string, name: string | null): Promise<void> {
  const labels = await readLabels();
  if (!name) delete labels[sessionId];
  else labels[sessionId] = { name: name.slice(0, 80) };
  await writeLabels(labels);
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  // Search across both roots; if both have it, return the newer one.
  let best: { path: string; mtime: number } | null = null;
  for (const root of PROJECT_ROOTS) {
    if (!existsSync(root)) continue;
    let projs;
    try { projs = await readdir(root); } catch { continue; }
    for (const proj of projs) {
      const candidate = join(root, proj, `${sessionId}.jsonl`);
      if (!existsSync(candidate)) continue;
      try {
        const st = await stat(candidate);
        if (!st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtime) best = { path: candidate, mtime: st.mtimeMs };
      } catch { /* ignore */ }
    }
  }
  return best?.path ?? null;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  let removed = false;
  for (const root of PROJECT_ROOTS) {
    if (!existsSync(root)) continue;
    let projs;
    try { projs = await readdir(root); } catch { continue; }
    for (const proj of projs) {
      const candidate = join(root, proj, `${sessionId}.jsonl`);
      if (!existsSync(candidate)) continue;
      try { await unlink(candidate); removed = true; } catch { /* keep trying */ }
    }
  }
  if (removed) {
    const labels = await readLabels();
    delete labels[sessionId];
    await writeLabels(labels);
  }
  return removed;
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

// ────────────────────────────────────────────────────────────────
// Materialize history for a session
// ────────────────────────────────────────────────────────────────
export async function getSessionMessages(
  sessionId: string,
  limit: number
): Promise<SessionMessagesResponse | null> {
  const path = await findSessionFile(sessionId);
  if (!path) return null;

  let text: string;
  try { text = await readFile(path, 'utf-8'); } catch { return null; }
  const lines = text.split('\n');

  const messages: HistoryMessage[] = [];
  let cwd = '';
  let total = 0;

  for (const line of lines) {
    if (!line) continue;
    total++;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof obj?.cwd === 'string') cwd = obj.cwd;

    if (obj.type === 'user' && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text') {
            const cleaned = cleanUserText(String(block.text || ''));
            if (cleaned) messages.push({ role: 'user', text: cleaned });
          } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            messages.push({
              role: 'tool_result',
              toolUseId: block.tool_use_id,
              content: stringifyToolResultContent(block.content).slice(0, 4000),
              isError: !!block.is_error,
            });
          }
        }
      } else if (typeof content === 'string') {
        const cleaned = cleanUserText(content);
        if (cleaned) messages.push({ role: 'user', text: cleaned });
      }
      continue;
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        let textBuf: string[] = [];
        const flush = () => {
          const t = textBuf.join('').trim();
          if (t) messages.push({ role: 'assistant', text: t });
          textBuf = [];
        };
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            textBuf.push(block.text);
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            flush();
            messages.push({
              role: 'tool_use',
              toolUseId: block.id,
              name: String(block.name || ''),
              input: block.input ?? {},
            });
          }
        }
        flush();
      }
      continue;
    }
  }

  const limited = limit > 0 && messages.length > limit
    ? messages.slice(-limit)
    : messages;

  return {
    sessionId,
    cwd: cwd || '',
    messages: limited,
    total: messages.length,
  };
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
    try { body = await c.req.json(); } catch { /* allow empty */ }
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
    const result = await getSessionMessages(id, isNaN(limit) ? 30 : limit);
    if (!result) return c.json({ error: 'not found' }, 404);
    return c.json(result);
  });

  app.get('/api/recent-cwds', async (c) => {
    if (!authed(c, token)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ cwds: await recentCwds() });
  });
}
