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

export type PushPayload = {
  title: string;
  body: string;
  /** Used as the SW notification tag, lets multiple notifications collapse. */
  tag?: string;
  /** Where the SW navigates on click. Default '/launch'. */
  url?: string;
  /** Optional session id for the client to pre-select after focus. */
  sessionId?: string;
};

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
