// Local usage telemetry (UX research, NOT analytics-as-a-service).
//
// Mobile and desktop usage habits differ; we want data to tune the
// experience per surface. PRIVACY: everything stays local on the user's own
// machine (a JSONL file under ~/.config/agentphone/), never sent anywhere —
// same Tailscale-local principle as the rest of agentphone. We log event
// NAMES + coarse props (counts, booleans, enums), never prompt/reply CONTENT.
//
// Events are appended by the WS layer when the client emits a `usage`
// message; GET /api/usage returns an aggregate summary the user can inspect.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PATH = join(homedir(), '.config', 'agentphone', 'usage.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;  // ~5MB cap; oldest lines dropped past it

export type UsageEvent = {
  ts: number;
  /** event name, e.g. 'prompt_sent' | 'tool_approve' | 'fork' | 'voice_input' */
  name: string;
  /** 'pwa' | 'apk' — which client shell */
  shell?: string;
  /** 'mobile' | 'desktop' — coarse form factor (from UA + viewport) */
  form?: string;
  /** coarse, content-free props (counts/booleans/enums only) */
  props?: Record<string, unknown>;
};

let writeChain: Promise<void> = Promise.resolve();

/** Append one event. Fire-and-forget friendly; never throws to the caller. */
export function recordUsage(ev: UsageEvent): void {
  const line = JSON.stringify(ev) + '\n';
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(dirname(PATH), { recursive: true });
      await appendFile(PATH, line, 'utf8');
      // Trim if too big: keep the newest half.
      const { stat, readFile: rf, writeFile } = await import('node:fs/promises');
      const st = await stat(PATH);
      if (st.size > MAX_BYTES) {
        const buf = await rf(PATH);
        const half = buf.subarray(Math.floor(buf.length / 2));
        const nl = half.indexOf(0x0a);
        await writeFile(PATH, nl >= 0 ? half.subarray(nl + 1) : half);
      }
    } catch { /* telemetry must never break the app */ }
  });
}

export type UsageSummary = {
  total: number;
  firstAt: number | null;
  lastAt: number | null;
  byEvent: Record<string, number>;
  byShell: Record<string, number>;
  byForm: Record<string, number>;
  /** event-name × form (mobile vs desktop) — the comparison that matters */
  eventByForm: Record<string, Record<string, number>>;
  recent: UsageEvent[];
};

/** Read the whole log and aggregate. Cheap enough at a few MB. */
export async function usageSummary(recentN = 40): Promise<UsageSummary> {
  let text = '';
  try { text = await readFile(PATH, 'utf8'); } catch { /* no file yet */ }
  const lines = text.split('\n').filter((l) => l.trim());
  const sum: UsageSummary = {
    total: 0, firstAt: null, lastAt: null,
    byEvent: {}, byShell: {}, byForm: {}, eventByForm: {}, recent: [],
  };
  const all: UsageEvent[] = [];
  for (const l of lines) {
    let e: UsageEvent;
    try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e.name !== 'string') continue;
    all.push(e);
    sum.total++;
    if (sum.firstAt === null || e.ts < sum.firstAt) sum.firstAt = e.ts;
    if (sum.lastAt === null || e.ts > sum.lastAt) sum.lastAt = e.ts;
    sum.byEvent[e.name] = (sum.byEvent[e.name] ?? 0) + 1;
    const shell = e.shell || 'unknown';
    const form = e.form || 'unknown';
    sum.byShell[shell] = (sum.byShell[shell] ?? 0) + 1;
    sum.byForm[form] = (sum.byForm[form] ?? 0) + 1;
    (sum.eventByForm[e.name] ??= {})[form] = (sum.eventByForm[e.name]?.[form] ?? 0) + 1;
  }
  sum.recent = all.slice(-recentN);
  return sum;
}
