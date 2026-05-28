// CodexAdapter — stub HarnessAdapter for OpenAI's codex CLI.
//
// This is intentionally a thin reference implementation, not a fully working
// codex driver. Its job in Phase 5 is to prove the HarnessAdapter abstraction
// holds for a second harness — listSessions() / ownsSession() return clean
// empty results when codex isn't installed, and startTurn() throws a clear
// "not supported yet" so we fail fast instead of hanging an SDK call.
//
// To turn this into a real adapter, follow hapi's pattern
// (cli/src/codex/codexLocal.ts in /tmp/survey/hapi):
//   - spawn('codex', ['resume', sessionId, '--model', model, ...])
//   - parse codex's stream output (JSON-RPC over stdout) into AgentEvent
//   - watch ~/.codex/sessions/<id>.json for live updates
//
// Until then we just make the registry happy.

import { existsSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
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

// Common codex install locations. We probe these on demand so a missing
// install just yields zero sessions instead of crashing the registry.
const CODEX_DIRS = [
  join(homedir(), '.codex'),
  join(homedir(), '.config', 'codex'),
];

function codexBinaryPath(): string | null {
  // PATH lookup. Cheap, runs once per session list.
  const PATH = process.env.PATH ?? '';
  for (const seg of PATH.split(':')) {
    if (!seg) continue;
    const candidate = join(seg, 'codex');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function codexSessionsRoot(): string | null {
  for (const d of CODEX_DIRS) {
    const sessions = join(d, 'sessions');
    if (existsSync(sessions)) return sessions;
  }
  return null;
}

export class CodexAdapter implements HarnessAdapter {
  readonly harnessKind: HarnessKind = 'codex';
  readonly agentKind: AgentKind = 'codex';
  readonly mode = 'owned' as const;
  // Back-compat alias mirrored from claude-sdk adapter.
  readonly kind: AgentKind = 'codex';

  async listSessions(): Promise<SessionSummary[]> {
    const root = codexSessionsRoot();
    if (!root) return [];
    let entries: string[];
    try { entries = readdirSync(root); }
    catch { return []; }

    const out: SessionSummary[] = [];
    for (const f of entries) {
      // Codex's actual session format isn't pinned down here — we'd want to
      // parse the file header for prompt/preview/model/turns. For the stub
      // we just emit a minimal SessionSummary so the framework wires through.
      if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
      const sessionId = f.replace(/\.(json|jsonl)$/, '');
      const full = join(root, f);
      let mtimeMs = 0;
      try { mtimeMs = (await stat(full)).mtimeMs; } catch { /* ignore */ }
      out.push({
        sessionId,
        cwd: '',          // would need to parse file
        name: null,
        preview: '(codex session — adapter stub)',
        lastUsed: mtimeMs,
        turns: 0,
        agent: 'codex',
      });
    }
    return out;
  }

  async getSessionMessages(_sessionId: string, _limit: number): Promise<SessionMessagesResponse | null> {
    // Real impl would parse codex's per-session file. Stub returns null so the
    // REST endpoint sends 404 cleanly.
    return null;
  }

  async ownsSession(sessionId: string): Promise<boolean> {
    const root = codexSessionsRoot();
    if (!root) return false;
    return existsSync(join(root, `${sessionId}.json`)) ||
           existsSync(join(root, `${sessionId}.jsonl`));
  }

  async deleteSession(_sessionId: string): Promise<boolean> {
    // Decline to delete from the stub — better to crash an explicit DELETE
    // than to silently nuke codex state we don't fully model yet.
    return false;
  }

  async recentCwds(): Promise<string[]> {
    return [];
  }

  startTurn(_opts: StartTurnOptions): AgentTurn {
    const bin = codexBinaryPath();
    const hint = bin
      ? 'codex binary found but the adapter that drives it is still a stub'
      : 'codex binary not found on PATH';
    throw new Error(
      `Codex harness is not yet implemented in agentphone (${hint}). ` +
      `Use the claude-sdk harness, or implement codex/adapter.ts startTurn following hapi's codexLocal.ts.`,
    );
  }
}
