// External session tracker.
//
// cmax (the Claude CLI account-manager wrapper) writes a per-PID JSON to
// `~/.claude-accounts/<account>/sessions/<pid>.json` whenever a claude.exe
// is driving a session. Fields we care about:
//   pid, sessionId, cwd, kind, status ('idle'|'busy'), procStart, updatedAt
//
// We poll those files so the agentphone UI knows when another end (a CLI on
// the desktop, a bg job, etc.) is currently driving the same session. That
// lets us show a 🟢 dot in the drawer and a follow-mode banner instead of
// silently double-writing into the same jsonl.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const ACCOUNTS_ROOT = join(HOME, '.claude-accounts');

// We do NOT filter on updatedAt directly — cmax heartbeats the file lazily
// (often >5min apart even while busy). The authoritative liveness check is
// /proc/<pid>/stat starttime matching the file's procStart. updatedAt is only
// used to pick the freshest entry when multiple files name the same sessionId.

export type ExternalSessionInfo = {
  sessionId: string;
  pid: number;
  cwd: string;
  kind: string;          // 'interactive' | 'bg' | etc.
  account: string;       // 'cmax' | 'cpro1' | …
  status: 'idle' | 'busy';
  updatedAt: number;
};

type Listener = (sessionId: string, info: ExternalSessionInfo | null) => void;

export class ExternalSessionTracker {
  private map = new Map<string, ExternalSessionInfo>();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private myPids: Set<number>;

  constructor() {
    // Don't shadow our own claude.exe children — agentphone's own runner
    // state is tracked separately and already surfaces as `running:true`.
    this.myPids = new Set([process.pid]);
    if (process.ppid) this.myPids.add(process.ppid);
  }

  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    // Don't keep the event loop alive just for this.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Latest known info for sessionId, or null if nothing external is driving it. */
  get(sessionId: string): ExternalSessionInfo | null {
    return this.map.get(sessionId) ?? null;
  }

  /** Snapshot of all currently-tracked external sessions. */
  all(): ExternalSessionInfo[] {
    return Array.from(this.map.values());
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ─── internals ──────────────────────────────────────────────

  private scan(): void {
    const next = new Map<string, ExternalSessionInfo>();
    if (!existsSync(ACCOUNTS_ROOT)) {
      this.diffAndPublish(next);
      return;
    }

    let accounts: string[];
    try {
      accounts = readdirSync(ACCOUNTS_ROOT);
    } catch {
      this.diffAndPublish(next);
      return;
    }

    for (const account of accounts) {
      const sessDir = join(ACCOUNTS_ROOT, account, 'sessions');
      if (!existsSync(sessDir)) continue;
      let files: string[];
      try { files = readdirSync(sessDir); } catch { continue; }

      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const full = join(sessDir, f);
        let raw: string;
        try { raw = readFileSync(full, 'utf8'); } catch { continue; }
        let d: any;
        try { d = JSON.parse(raw); } catch { continue; }

        const pid = d?.pid;
        const sessionId = d?.sessionId;
        const updatedAt = d?.updatedAt;
        if (typeof pid !== 'number' || typeof sessionId !== 'string') continue;
        if (typeof updatedAt !== 'number') continue;
        if (this.myPids.has(pid)) continue;
        // The /proc/<pid>/stat starttime match is the authoritative liveness
        // signal — if the pid is alive AND its starttime matches the file's
        // procStart fingerprint, this is the actual owner regardless of how
        // stale updatedAt looks.
        if (!processAlive(pid, d.procStart)) continue;

        const status: 'idle' | 'busy' = d.status === 'busy' ? 'busy' : 'idle';
        const info: ExternalSessionInfo = {
          sessionId,
          pid,
          cwd: String(d.cwd || ''),
          kind: String(d.kind || 'interactive'),
          account,
          status,
          updatedAt,
        };

        // Multiple entries per sessionId can exist if claude restarted —
        // keep the freshest.
        const prev = next.get(sessionId);
        if (!prev || prev.updatedAt < info.updatedAt) next.set(sessionId, info);
      }
    }

    this.diffAndPublish(next);
  }

  private diffAndPublish(next: Map<string, ExternalSessionInfo>): void {
    // Emit removals.
    for (const [sid, prev] of this.map) {
      const curr = next.get(sid);
      if (!curr) {
        for (const l of this.listeners) {
          try { l(sid, null); } catch { /* ignore */ }
        }
      } else if (curr.status !== prev.status || curr.pid !== prev.pid) {
        for (const l of this.listeners) {
          try { l(sid, curr); } catch { /* ignore */ }
        }
      }
    }
    // Emit additions.
    for (const [sid, curr] of next) {
      if (!this.map.has(sid)) {
        for (const l of this.listeners) {
          try { l(sid, curr); } catch { /* ignore */ }
        }
      }
    }
    this.map = next;
  }
}

/** True if pid exists AND its starttime matches procStart (no recycle). */
function processAlive(pid: number, procStart?: string): boolean {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) return false;
  if (!procStart) return true;     // no fingerprint to compare; accept liveness
  try {
    const raw = readFileSync(statPath, 'utf8');
    // /proc/PID/stat: comm is in parens (may contain spaces). Take after last ')'.
    const after = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    // Field 22 (starttime, 0-indexed from after-comm = index 19).
    const starttime = after[19];
    return String(starttime) === String(procStart);
  } catch {
    return false;
  }
}

// Module-level singleton — main.ts starts it on boot.
export const externalSessions = new ExternalSessionTracker();
