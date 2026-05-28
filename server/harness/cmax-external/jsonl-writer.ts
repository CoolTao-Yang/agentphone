// jsonl-writer.ts — append entries into another claude.exe's session JSONL.
//
// Used by Phase 3 to:
//   1. (β path) Inject a phone-typed user message into a CLI-owned session
//      so cmax can queue it and the user can trigger the response from the
//      desktop CLI. The format matches what cmax itself writes so the line
//      passes its own JSONL schema validation.
//
//   2. (α path) Mirror a phone-owned session's completed turn back into a
//      linked external CLI session as a marked metadata entry. Same shape
//      as a user message but with isMeta + isSidechain + isVisibleInTranscriptOnly
//      all set so cmax shows it in the transcript without sending it to the
//      API or auto-firing a response.
//
// Both modes use atomic appendFile so concurrent writers can't interleave a
// half-line; cmax does the same on its end.

import { appendFile, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ImageAttachment } from '../../../shared/types.ts';

const VERSION_TAG = 'agentphone-3.0';

type RawEntry = Record<string, unknown>;

export type InjectOptions = {
  /** ISO timestamp; defaults to now. */
  timestamp?: string;
  /** cwd to record on the entry (cmax's TUI uses this for display). Defaults
   *  to whatever the last entry in the file carries, falling back to '/'.
   */
  cwd?: string;
  /** Permission mode tag. cmax uses 'default' | 'auto' | 'plan'; mirror just
   *  defaults to 'default'.
   */
  permissionMode?: string;
};

export type MirrorOptions = InjectOptions & {
  /** Optional phone-side identifier (rendered in the prefix so the desktop
   *  user can tell which phone-side B session emitted this entry). */
  phoneSessionId?: string;
};

/**
 * β path: append a real user message entry. cmax sees it as if the user
 * typed in another window — it gets queued in cmax's TUI. If cmax is at
 * an interactive prompt it may auto-fire; otherwise the desktop user must
 * press Enter to commit.
 */
export async function appendInjectUserMessage(
  jsonlPath: string,
  externalSessionId: string,
  text: string,
  opts: InjectOptions = {},
): Promise<string> {
  const parent = await pickParentUuid(jsonlPath);
  const cwd = opts.cwd ?? (await pickLatestCwd(jsonlPath)) ?? '/';
  const entry: RawEntry = {
    parentUuid: parent,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: { role: 'user', content: text },
    uuid: randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    permissionMode: opts.permissionMode ?? 'default',
    userType: 'external',          // matches the value cmax uses for itself
    entrypoint: 'cli',
    cwd,
    sessionId: externalSessionId,
    version: VERSION_TAG,
    gitBranch: 'HEAD',
  };
  await appendFile(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry.uuid as string;
}

/**
 * α path: append a metadata-marked user-shape entry summarizing a phone-side
 * turn. Marked isMeta + isSidechain + isVisibleInTranscriptOnly so cmax
 * displays it as a side note in the transcript without sending to the API
 * or counting it toward the user's turn queue. Content is human-readable;
 * structure stays parsable so we can re-extract on follow-mode replay.
 */
export async function appendMirrorEntry(
  jsonlPath: string,
  externalSessionId: string,
  userPrompt: string,
  assistantText: string,
  opts: MirrorOptions = {},
): Promise<string> {
  const parent = await pickParentUuid(jsonlPath);
  const cwd = opts.cwd ?? (await pickLatestCwd(jsonlPath)) ?? '/';
  const phoneTag = opts.phoneSessionId ? ` ${opts.phoneSessionId.slice(0, 8)}` : '';
  const userBlock = userPrompt ? `> ${truncateForMirror(userPrompt)}\n\n` : '';
  const assistantBlock = assistantText ? truncateForMirror(assistantText) : '(no text response)';
  const content = `📱 [phone mirror${phoneTag}]\n\n${userBlock}${assistantBlock}`;
  const entry: RawEntry = {
    parentUuid: parent,
    isSidechain: true,                  // signals "not on the main thread"
    isMeta: true,                       // metadata, not real user input
    isVisibleInTranscriptOnly: true,    // shown but never sent to the API
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    permissionMode: opts.permissionMode ?? 'default',
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: externalSessionId,
    version: VERSION_TAG,
    gitBranch: 'HEAD',
    // Custom marker our jsonl-watcher and any future tooling can filter on.
    agentphoneMirror: {
      phoneSessionId: opts.phoneSessionId ?? null,
    },
  };
  await appendFile(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry.uuid as string;
}

// ── Helpers ───────────────────────────────────────────────────

const MIRROR_TRUNCATE_CHARS = 2000;
function truncateForMirror(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MIRROR_TRUNCATE_CHARS) return trimmed;
  return trimmed.slice(0, MIRROR_TRUNCATE_CHARS) + `\n\n[…truncated, ${trimmed.length - MIRROR_TRUNCATE_CHARS} more chars]`;
}

async function pickParentUuid(jsonlPath: string): Promise<string | null> {
  const last = await tailLastEntry(jsonlPath);
  if (last && typeof last.uuid === 'string') return last.uuid;
  return null;
}

async function pickLatestCwd(jsonlPath: string): Promise<string | null> {
  const last = await tailLastEntry(jsonlPath);
  if (last && typeof last.cwd === 'string') return last.cwd;
  return null;
}

/** Read the very last complete JSON line from the file. Cheap by reading
 *  only the trailing window; falls back to a full read for small files. */
async function tailLastEntry(jsonlPath: string): Promise<RawEntry | null> {
  let st;
  try { st = await stat(jsonlPath); }
  catch { return null; }
  const size = st.size;
  if (size === 0) return null;

  // Read up to last 16KiB; should be enough to find at least one complete
  // line for any realistic single entry.
  const tailLen = Math.min(size, 16 * 1024);
  let buf: Buffer;
  try {
    if (tailLen === size) {
      buf = await readFile(jsonlPath);
    } else {
      const { open } = await import('node:fs/promises');
      const fh = await open(jsonlPath, 'r');
      try {
        buf = Buffer.alloc(tailLen);
        await fh.read(buf, 0, tailLen, size - tailLen);
      } finally {
        await fh.close();
      }
    }
  } catch {
    return null;
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // Walk from the end, find the last well-formed JSON line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== '{') continue;
    try { return JSON.parse(line) as RawEntry; }
    catch { continue; }
  }
  return null;
}

export type _MirrorImagesUnused = ImageAttachment;  // satisfy types import lint

// ── Merge: B's whole conversation → one user prompt injected into A ──

/**
 * Read every user/assistant turn from the phone-owned session's jsonl,
 * format them into a single human-readable transcript block, and append
 * that block as a single user message to the linked external (cmax)
 * session's jsonl. cmax queues the message; the desktop user presses
 * Enter to let claude.exe pick it up as the next API call's prompt —
 * effectively splicing B's context into A's conversation.
 *
 * Returns the uuid of the injected entry + how many turns were merged.
 */
export async function mergeFromPhoneSession(
  externalJsonlPath: string,
  externalSessionId: string,
  phoneJsonlPath: string,
  opts: { phoneSessionLabel?: string; externalCwd?: string } = {},
): Promise<{ uuid: string; turnsMerged: number }> {
  const turns = await readPhoneTurns(phoneJsonlPath);
  const label = opts.phoneSessionLabel || phoneSessionLabel(phoneJsonlPath);
  const block = formatMergeBlock(turns, label);
  const uuid = await appendInjectUserMessage(externalJsonlPath, externalSessionId, block, {
    cwd: opts.externalCwd,
    permissionMode: 'default',
  });
  return { uuid, turnsMerged: turns.length };
}

type PhoneTurn = { userText: string; assistantText: string };

async function readPhoneTurns(path: string): Promise<PhoneTurn[]> {
  const turns: PhoneTurn[] = [];
  let stream;
  try { stream = createReadStream(path, { encoding: 'utf8' }); }
  catch { return turns; }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let pendingUser: string | null = null;
  let pendingAssistant = '';
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    // user prompt
    if (entry.type === 'user' && entry.message?.role === 'user') {
      // flush previous pair if any
      if (pendingUser !== null) {
        turns.push({ userText: pendingUser, assistantText: pendingAssistant.trim() });
      }
      pendingUser = extractText(entry.message.content);
      pendingAssistant = '';
      continue;
    }
    // assistant reply (one entry per message; we concat text blocks)
    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      pendingAssistant += extractText(entry.message.content);
      continue;
    }
  }
  // tail flush
  if (pendingUser !== null) {
    turns.push({ userText: pendingUser, assistantText: pendingAssistant.trim() });
  }
  // Drop empties (user msg with no body)
  return turns.filter((t) => t.userText.trim().length > 0);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && typeof b === 'object') {
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'thinking') continue;  // skip thinking
      // tool_use/tool_result deliberately omitted from merge — they bloat
      // the context and aren't useful as conversation history.
    }
  }
  return parts.join('\n');
}

function phoneSessionLabel(path: string): string {
  const tail = path.split('/').pop() ?? '';
  return tail.replace(/\.jsonl$/, '').slice(0, 8);
}

const MERGE_TURN_TRUNCATE = 4000;
function truncateForMerge(s: string): string {
  if (s.length <= MERGE_TURN_TRUNCATE) return s;
  return s.slice(0, MERGE_TURN_TRUNCATE) + `\n[…${s.length - MERGE_TURN_TRUNCATE} chars truncated]`;
}

function formatMergeBlock(turns: PhoneTurn[], label: string): string {
  if (turns.length === 0) {
    return `📱 [merge from phone session ${label}] (no turns to merge)`;
  }
  const header = `📱 把手机 session ${label} 的 ${turns.length} 轮对话合并过来 — 请把它当作之前已经发生的上下文，继续这个话题。`;
  const body = turns.map((t, i) => {
    const u = truncateForMerge(t.userText.trim());
    const a = truncateForMerge(t.assistantText.trim()) || '(no text response)';
    return `── 轮 ${i + 1} ──\n[用户]\n${u}\n\n[助手]\n${a}`;
  }).join('\n\n');
  return `${header}\n\n${body}\n\n── 合并结束 ──`;
}
