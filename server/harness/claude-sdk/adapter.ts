// ClaudeSdkAdapter — drives @anthropic-ai/claude-agent-sdk and translates the
// SDK's Beta-event stream into our normalized AgentEvent shape. Mode = 'owned':
// we spawn the underlying claude.exe ourselves, no one else races for assistant
// writes on these session jsonls.

import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool as ClaudeCanUseTool,
  type PermissionResult,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  HistoryMessage,
  SessionMessagesResponse,
  SessionSummary,
} from '../../../shared/types.ts';
import type {
  AgentKind,
  AgentTurn,
  HarnessAdapter,
  HarnessKind,
  StartTurnOptions,
} from '../types.ts';

const HOME = homedir();
const PROJECT_ROOTS = [
  join(HOME, '.claude', 'projects'),
  join(HOME, '.claude-shared', 'projects'),
];

// System wrappers Claude Code injects around slash commands.
const CAVEAT_RX = /<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g;
const COMMAND_RX = /<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
function cleanUserText(s: string): string {
  if (!s) return '';
  return s.replace(CAVEAT_RX, '').replace(COMMAND_RX, '').trim();
}

function decodeProjectFolder(folder: string): string {
  return folder.replace(/-/g, '/');
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
        const cleaned = cleanUserText(blockText(obj.message.content)).replace(/\s+/g, ' ').trim();
        if (cleaned.length >= 2) preview = cleaned;
      }
    }
  } catch { /* ignore */ }
  return { preview: preview.slice(0, 120) || '(空)', turns, cwd };
}

/** Synchronous variant — used from startTurn() which can't await. Returns
 *  true if any project root contains a `<sessionId>.jsonl`. */
function sessionJsonlExistsSync(sessionId: string): boolean {
  for (const root of PROJECT_ROOTS) {
    if (!existsSync(root)) continue;
    let projs: string[];
    try { projs = readdirSync(root); } catch { continue; }
    for (const proj of projs) {
      if (existsSync(join(root, proj, `${sessionId}.jsonl`))) return true;
    }
  }
  return false;
}

/** Locate the latest jsonl file for a sessionId across all PROJECT_ROOTS.
 *  Exported so other modules (e.g. cmax-external/jsonl-writer.mergeFromPhoneSession)
 *  can resolve a phone-owned session's path without re-implementing the walk. */
export async function findSessionFile(sessionId: string): Promise<string | null> {
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

export class ClaudeSdkAdapter implements HarnessAdapter {
  readonly harnessKind: HarnessKind = 'claude-sdk';
  readonly agentKind: AgentKind = 'claude';
  readonly mode = 'owned' as const;
  // Back-compat alias for the old `kind` field; some helpers still expect it.
  readonly kind: AgentKind = 'claude';

  startTurn(opts: StartTurnOptions): AgentTurn {
    const turnId = randomUUID();

    const claudeCanUseTool: ClaudeCanUseTool = async (toolName, input, options) => {
      // Pass the SDK's real toolUseID so the runner's tool_request shares an
      // id with the eventual tool_result (which carries the same SDK id) —
      // otherwise the client can't fold the result into its card.
      const sdkToolUseId = (options as any)?.toolUseID as string | undefined;
      const r = await opts.canUseTool(toolName, input as Record<string, unknown>, sdkToolUseId);
      if (r.allow) {
        return { behavior: 'allow', updatedInput: r.updatedInput ?? input } satisfies PermissionResult;
      }
      return {
        behavior: 'deny',
        message: r.reason || '用户在手机端拒绝了这个工具调用。',
        interrupt: false,
      } as unknown as PermissionResult;
    };

    // If there are image attachments, build a multimodal SDKUserMessage and
    // hand it as an AsyncIterable. Otherwise pass the prompt string directly
    // (simpler and lets the SDK do its own message wrapping).
    let promptArg: any = opts.prompt;
    if (opts.images && opts.images.length > 0) {
      const images = opts.images;
      const text = opts.prompt;
      promptArg = (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text },
              ...images.map((img) => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              })),
            ],
          },
        } as any;
      })();
    }

    // Validate resume id on disk. Without this, a ghost id from a previous
    // turn that errored before writing any jsonl (e.g. ede_diagnostic) gets
    // passed to claude.exe as --resume, and the SDK hangs forever trying to
    // read a non-existent file. hapi does the same check in their
    // claudeLocal.ts; we should have always done it.
    let resumeId = opts.sessionId;
    if (resumeId && !sessionJsonlExistsSync(resumeId)) {
      console.warn(
        `[claude-sdk] session ${resumeId.slice(0, 8)} not found on disk — ` +
        `dropping --resume and starting fresh`,
      );
      resumeId = null;
    }

    const q: Query = query({
      prompt: promptArg,
      options: {
        cwd: opts.cwd,
        ...(resumeId ? { resume: resumeId } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        permissionMode: 'default',
        canUseTool: claudeCanUseTool,
        includePartialMessages: true,
      },
    });

    const iterate = async function* (): AsyncGenerator<AgentEvent, void> {
      // Per-block accumulator for input_json_delta (used in event/log only;
      // canUseTool gets the parsed input directly from SDK).
      const toolUseAccum = new Map<string, { id: string; name: string; inputJson: string }>();
      let sessionIdEmitted = false;
      // Anthropic streaming wraps each event in its own SDK envelope with a
      // fresh `m.uuid`, so using m.uuid as the client's messageId means every
      // single text_delta gets a different id → client's streamState (keyed
      // by messageId:kind) never finds a previous entry → each delta becomes
      // its own mblock → marked sees tiny fragments → tables/code spanning
      // deltas never render. The actual stable id is the Anthropic message
      // id which arrives on `message_start.message.id`; we keep it across
      // all events until `message_stop` and reset for the next message.
      let currentMessageId: string | null = null;

      for await (const sdkMsg of q) {
        const m = sdkMsg as any;

        if (!sessionIdEmitted && typeof m?.session_id === 'string') {
          sessionIdEmitted = true;
          yield { kind: 'session_init', sessionId: m.session_id };
        }

        if (m.type === 'stream_event') {
          const ev = m.event;
          if (!ev) continue;
          if (ev.type === 'message_start' && typeof ev.message?.id === 'string') {
            currentMessageId = ev.message.id;
          }
          const messageId = currentMessageId ?? String(m.uuid ?? 'unknown');
          const blockIndex = typeof ev.index === 'number' ? ev.index : 0;
          const key = `${messageId}:${blockIndex}`;

          if (ev.type === 'content_block_start') {
            const b = ev.content_block;
            const t: 'text' | 'tool_use' | 'thinking' =
              b?.type === 'text' ? 'text' :
              b?.type === 'tool_use' ? 'tool_use' :
              b?.type === 'thinking' ? 'thinking' : 'text';
            if (t === 'tool_use' && typeof b?.id === 'string' && typeof b?.name === 'string') {
              toolUseAccum.set(key, { id: b.id, name: b.name, inputJson: '' });
            }
            yield { kind: 'assistant_block_start', messageId, blockIndex, blockType: t };
            continue;
          }

          if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              yield { kind: 'text_delta', messageId, blockIndex, delta: d.text };
            } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
              yield { kind: 'thinking_delta', messageId, blockIndex, delta: d.thinking };
            } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const acc = toolUseAccum.get(key);
              if (acc) acc.inputJson += d.partial_json;
            }
            continue;
          }

          if (ev.type === 'content_block_stop') {
            yield { kind: 'assistant_block_end', messageId, blockIndex };
            continue;
          }
          // Next assistant message gets a fresh stable id.
          if (ev.type === 'message_stop') {
            currentMessageId = null;
            continue;
          }
          continue;
        }

        if (m.type === 'user' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
              const content = stringifyToolResultContent(block.content);
              yield {
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                content: content.slice(0, 8000),
                isError: !!block.is_error,
              };
            }
          }
          continue;
        }

        if (m.type === 'result') {
          yield {
            kind: 'result',
            success: m.subtype === 'success',
            durationMs: m.duration_ms ?? 0,
            turns: m.num_turns ?? 0,
            costUsd: m.total_cost_usd ?? 0,
            isError: !!m.is_error,
          };
          continue;
        }
      }
    };

    return {
      turnId,
      iterate,
      async interrupt() {
        try { await q.interrupt(); } catch { /* ignore */ }
      },
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
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
            name: null, // labels merged at higher layer
            preview,
            lastUsed: st.mtimeMs,
            turns,
            agent: 'claude',
          });
        }
      }
    }
    return [...best.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  async getSessionMessages(sessionId: string, limit: number): Promise<SessionMessagesResponse | null> {
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
          // Collect text + images from the same user message into a single
          // user history entry so the phone can render them together.
          let userText = '';
          const userImages: { mediaType: any; data: string }[] = [];
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text') {
              const cleaned = cleanUserText(String(block.text || ''));
              if (cleaned) userText = userText ? userText + '\n' + cleaned : cleaned;
            } else if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
              userImages.push({
                mediaType: block.source.media_type || 'image/png',
                data: block.source.data,
              });
            } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              messages.push({
                role: 'tool_result',
                toolUseId: block.tool_use_id,
                content: stringifyToolResultContent(block.content).slice(0, 4000),
                isError: !!block.is_error,
              });
            }
          }
          if (userText || userImages.length) {
            messages.push({
              role: 'user',
              text: userText,
              ...(userImages.length ? { images: userImages as any } : {}),
            });
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
          let buf: string[] = [];
          const flush = () => {
            const t = buf.join('').trim();
            if (t) messages.push({ role: 'assistant', text: t });
            buf = [];
          };
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
              buf.push(block.text);
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

    const limited = limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;
    return { sessionId, cwd: cwd || '', messages: limited, total: messages.length };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    let removed = false;
    for (const root of PROJECT_ROOTS) {
      if (!existsSync(root)) continue;
      let projs;
      try { projs = await readdir(root); } catch { continue; }
      for (const proj of projs) {
        const candidate = join(root, proj, `${sessionId}.jsonl`);
        if (!existsSync(candidate)) continue;
        try { await unlink(candidate); removed = true; } catch { /* ignore */ }
      }
    }
    return removed;
  }

  async ownsSession(sessionId: string): Promise<boolean> {
    return (await findSessionFile(sessionId)) !== null;
  }

  async recentCwds(): Promise<string[]> {
    const sessions = await this.listSessions();
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
}
