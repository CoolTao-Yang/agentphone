// jsonl-watcher.ts
//
// Tails an externally-driven Claude Code session JSONL file (the kind cmax,
// claude.exe, or a bg job appends to as the agent runs) and converts new
// entries into our normalized AgentEvent stream. Used by follow-mode so the
// phone sees CLI activity live (no 4-second polling).
//
// Derived from clay (MIT):
//   https://github.com/chadbyte/clay/blob/main/lib/claude-jsonl-watcher.js
//   Original copyright (c) 2026 Chad — MIT.
// Modifications (c) 2026 Zetao Yang — MIT.
//
// Differences from clay's original:
//   - Ported from JS to TS.
//   - Emits the full set of conversation events (user prompt, assistant text,
//     tool_use, tool_result) instead of clay's title + assistant-text only.
//   - Output is the AgentEvent shape that the rest of agentphone already
//     speaks; no new wire format.
//
// Architecture preserved from clay:
//   - fs.watch for live deltas + 2s poll fallback (fs.watch is unreliable on
//     network mounts and across WSL/Windows filesystem boundaries).
//   - Tracks read position so each invocation only re-parses new bytes.
//   - Holds a partial-line "leftover" buffer across reads.
//   - Initial scan seeds a "seen UUIDs" set so re-attaching mid-conversation
//     doesn't replay old turns.

import { existsSync, openSync, readSync, closeSync, statSync, watch, FSWatcher } from 'node:fs';
import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ImageAttachment } from '../../../shared/types.ts';

const HOME = homedir();

export type WatcherOptions = {
  /** Called for each new normalized event extracted from appended JSONL lines. */
  onEvent: (event: AgentEvent) => void;
  /** If true, emit events for content that exists at start (default false —
   *  callers usually fetched history separately and don't want a replay). */
  replayExisting?: boolean;
  /** Poll interval in ms (default 2000). */
  pollMs?: number;
};

type RawEntry = {
  type?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  // Tool result is delivered as a user-type entry with tool_use_id; system
  // metadata entries (ai-title, mode, …) get ignored.
};

/**
 * Watch a Claude Code session JSONL file and call onEvent for each new
 * conversation event. Returns a stop() function.
 *
 *   const stop = watchJsonl('/path/to/session.jsonl', { onEvent: ... });
 *   // ... later
 *   stop();
 */
export function watchJsonl(jsonlPath: string, opts: WatcherOptions): () => void {
  const pollMs = opts.pollMs ?? 2000;
  let stopped = false;
  let pos = 0;
  let leftover = '';
  let watcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let didInitialScan = false;
  const seenUuids = new Set<string>();

  function readNew(): void {
    if (stopped) return;
    let stat;
    try { stat = statSync(jsonlPath); }
    catch { return; }  // file may not exist yet
    if (stat.size <= pos) return;

    const len = stat.size - pos;
    const buf = Buffer.alloc(len);
    let fd: number;
    try { fd = openSync(jsonlPath, 'r'); }
    catch { return; }
    try {
      readSync(fd, buf, 0, len, pos);
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    pos = stat.size;

    const chunk = leftover + buf.toString('utf8');
    const parts = chunk.split('\n');
    // Last fragment may be a partial line; hold for next read.
    leftover = parts.pop() ?? '';

    for (const raw of parts) {
      const line = raw.trim();
      if (!line || line[0] !== '{') continue;
      let entry: RawEntry;
      try { entry = JSON.parse(line); }
      catch { continue; }

      // Dedup by uuid where present — re-reads can happen across fs.watch
      // misses + poll fallback.
      if (entry.uuid) {
        if (seenUuids.has(entry.uuid)) continue;
        seenUuids.add(entry.uuid);
      }

      // Skip the initial scan unless caller asked to replay. We still seed
      // seenUuids so future reads dedup correctly.
      if (!didInitialScan && !opts.replayExisting) continue;

      const events = entryToAgentEvents(entry);
      for (const e of events) {
        try { opts.onEvent(e); }
        catch { /* listener should never crash the watcher */ }
      }
    }
  }

  function arm(): void {
    if (stopped || watcher) return;
    if (!existsSync(jsonlPath)) return;
    try {
      watcher = watch(jsonlPath, { persistent: false }, () => readNew());
      watcher.on('error', () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        // Fall back to the poll loop; some filesystems (network mounts,
        // WSL/Windows interop) don't deliver fs.watch events reliably.
      });
    } catch {
      // Path doesn't exist yet; poll loop retries.
    }
  }

  // Initial pass: seeds seenUuids so subsequent reads emit only new content.
  readNew();
  didInitialScan = true;
  arm();

  // Poll every 2s as safety net + retry "file not there yet" case.
  pollTimer = setInterval(() => {
    if (!watcher) arm();
    readNew();
  }, pollMs);

  return function stop(): void {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  };
}

// ── Entry → AgentEvent conversion ─────────────────────────────

let blockCounter = 0;
function nextMessageId(): string {
  return `ext-msg-${Date.now()}-${blockCounter++}`;
}

function entryToAgentEvents(entry: RawEntry): AgentEvent[] {
  if (!entry || typeof entry !== 'object') return [];

  // User-type entries are either a new user prompt (role:'user' with text
  // content) or a tool_result echo (content array with tool_result blocks).
  if (entry.type === 'user' && entry.message?.role === 'user') {
    return userEntryToEvents(entry);
  }

  if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
    return assistantEntryToEvents(entry);
  }

  // Other types (system meta, ai-title, queue-operation, attachment, summary,
  // file-history-snapshot, mode, permission-mode, last-prompt) carry no UI
  // signal in follow-mode.
  return [];
}

function userEntryToEvents(entry: RawEntry): AgentEvent[] {
  const content = entry.message?.content;
  // String content = a direct user prompt typed in the CLI.
  if (typeof content === 'string') {
    const text = stripSystemWrappers(content).trim();
    if (!text) return [];
    return [{ kind: 'external_user_prompt', text } as AgentEvent];
  }
  if (!Array.isArray(content)) return [];

  const out: AgentEvent[] = [];
  const promptParts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') {
      const cleaned = stripSystemWrappers(block.text).trim();
      if (cleaned) promptParts.push(cleaned);
    } else if (t === 'tool_result' && typeof block.tool_use_id === 'string') {
      out.push({
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        content: stringifyToolResultContent(block.content),
        isError: !!block.is_error,
      });
    } else if (t === 'image' && typeof block.source === 'object' && block.source) {
      const src = block.source as Record<string, unknown>;
      const mediaType = src.media_type;
      const data = src.data;
      if (typeof mediaType === 'string' && typeof data === 'string' &&
          (mediaType === 'image/png' || mediaType === 'image/jpeg' ||
           mediaType === 'image/webp' || mediaType === 'image/gif')) {
        images.push({ mediaType, data });
      }
    }
  }

  if (promptParts.length > 0) {
    out.push({
      kind: 'external_user_prompt',
      text: promptParts.join('\n\n'),
      images: images.length > 0 ? images : undefined,
    } as AgentEvent);
  }
  return out;
}

function assistantEntryToEvents(entry: RawEntry): AgentEvent[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const messageId = entry.uuid ?? nextMessageId();
  const out: AgentEvent[] = [];

  let blockIndex = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      out.push({ kind: 'assistant_block_start', messageId, blockIndex, blockType: 'text' });
      out.push({ kind: 'text_delta', messageId, blockIndex, delta: block.text });
      out.push({ kind: 'assistant_block_end', messageId, blockIndex });
      blockIndex++;
    } else if (t === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      out.push({ kind: 'assistant_block_start', messageId, blockIndex, blockType: 'thinking' });
      out.push({ kind: 'thinking_delta', messageId, blockIndex, delta: block.thinking });
      out.push({ kind: 'assistant_block_end', messageId, blockIndex });
      blockIndex++;
    } else if (t === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      out.push({ kind: 'assistant_block_start', messageId, blockIndex, blockType: 'tool_use' });
      out.push({
        kind: 'tool_request',
        toolUseId: block.id,
        toolName: block.name,
        input: block.input ?? {},
        // External driver already executed the tool; from our side it's
        // auto-approved post-hoc.
        autoApproved: true,
      });
      out.push({ kind: 'assistant_block_end', messageId, blockIndex });
      blockIndex++;
    }
  }
  return out;
}

// Local-command wrappers Claude Code injects into user messages — they're
// noise for the chat surface (already handled by the broader stripper, but
// we mirror the same regexes here so this file stays self-contained).
const CAVEAT_RX = /<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g;
const COMMAND_RX = /<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
function stripSystemWrappers(s: string): string {
  if (!s) return '';
  return s.replace(CAVEAT_RX, '').replace(COMMAND_RX, '');
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object') {
      const obj = c as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text);
    } else if (typeof c === 'string') {
      parts.push(c);
    }
  }
  return parts.join('\n');
}

// ── Path helpers ──────────────────────────────────────────────

/**
 * Build the on-disk path for a session JSONL.
 *
 *   ~/.claude-accounts/<account>/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * Claude Code encodes cwd by replacing every non-alphanumeric char with '-',
 * which our cmax tracker already saw on real sessions like
 * `-home-yzt-test-claude4phone`.
 */
export function jsonlPathFor(account: string, cwd: string, sessionId: string): string {
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(HOME, '.claude-accounts', account, 'projects', encodedCwd, `${sessionId}.jsonl`);
}
