// Web Push wrapper — initialises web-push with the agentphone's VAPID keys
// (loaded from ~/.config/agentphone/env via process.env) and exposes a
// sendToAll() helper used by ws.ts on turn_done.
//
// Failure handling: a 404/410 from the push service means the subscription
// has been unsubscribed by the browser — we delete it from the store so the
// next fan-out skips it. Anything else is logged and ignored (we don't want
// one stale endpoint to block fan-out to healthy devices).

import webpush from 'web-push';
import { pushStore } from './store/push.ts';

let initialised = false;
function ensureInit(): boolean {
  if (initialised) return true;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  const subject = process.env.VAPID_SUBJECT || 'mailto:agentphone@localhost';
  if (!pub || !priv) {
    console.warn('[push] VAPID_PUBLIC / VAPID_PRIVATE not set — push is disabled');
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  initialised = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC ?? null;
}

export type PushKind = 'needs_input' | 'error' | 'done';

export type PushPayload = {
  title: string;
  body: string;
  /** Used as the SW notification tag, lets multiple notifications collapse. */
  tag?: string;
  /** Where the SW navigates on click. Default '/launch'. */
  url?: string;
  /** Optional session id for the client to pre-select after focus. */
  sessionId?: string;
  /** Semantic kind — lets the SW pick urgency (e.g. requireInteraction for
   *  needs_input/error) and the client route the tap. */
  kind?: PushKind;
};

// ── Push body helpers ────────────────────────────────────────

/** One-line, lock-screen-friendly summary of a tool call. Mirrors the
 *  client's oneLineInputSummary (static/app.js) but lives server-side so the
 *  runner can build a meaningful "Claude 需要确认" body. */
export function toolInputSummary(toolName: string, input: unknown): string {
  let detail = '';
  if (typeof input === 'string') {
    detail = input;
  } else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) { detail = v; break; }
    }
    if (!detail) {
      try { detail = JSON.stringify(input); } catch { /* ignore */ }
    }
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 100);
  return detail ? `${toolName}: ${detail}` : toolName;
}

/** Classify a turn error into a push title/kind. Mirrors the client's
 *  realContextLimit / sdkDiagnostic logic (static/app.js) so we don't
 *  mis-label a transient ede_diagnostic as "上下文已满". */
export function classifyTurnError(msg: string): { title: string; body: string } {
  const m = String(msg || '');
  const realContextLimit =
    /prompt\s*is\s*too\s*long|context[\s_-]*length[\s_-]*exceeded|maximum.*context[\s_-]*length|context\s*window.*exceed|exceeded.*context\s*window|tokens?\s*exceed.*context/i.test(m);
  const rateLimit =
    /rate.?limit|usage limit|too many requests|\b429\b|resets? at|quota/i.test(m);
  if (realContextLimit) return { title: '⚠️ 上下文已满', body: '点开压缩或新建 session' };
  if (rateLimit) return { title: '⏳ 已被限流', body: m.slice(0, 140) };
  return { title: '⚠️ 出错了', body: m.slice(0, 140) || 'Claude turn 失败' };
}

export async function sendToAll(payload: PushPayload): Promise<{ delivered: number; pruned: number }> {
  if (!ensureInit()) return { delivered: 0, pruned: 0 };
  const subs = await pushStore.all();
  if (subs.length === 0) return { delivered: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let delivered = 0;
  let pruned = 0;

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        body,
        { TTL: 60 },     // 60s relevance window — old turn_dones aren't useful
      );
      delivered++;
    } catch (err: any) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // gone — stop trying this endpoint
        await pushStore.delete(s.endpoint).catch(() => {});
        pruned++;
      } else {
        console.warn(`[push] send failed status=${status} endpoint=${s.endpoint.slice(0, 60)}...`);
      }
    }
  }));

  return { delivered, pruned };
}
