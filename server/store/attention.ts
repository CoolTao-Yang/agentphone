// Per-session "needs attention" registry (UX-BACKLOG #9).
//
// A WS client only subscribes to ONE session's runner at a time, so it can't
// learn about activity in OTHER sessions on its own. This module is the
// single server-side source of truth for "session X has something the user
// hasn't seen": the TurnRunner sets it when it fires a push (needs_input /
// error / done), ws.ts broadcasts changes to every connected socket so all
// drawers update live, and the client clears it (mark_seen) when the user
// actually views that session.
//
// In-memory: attention is ephemeral ("is there something to look at right
// now"), not durable state. A server restart clears it, which is fine — the
// turn it referred to is gone too.

import type { AttentionKind } from '../../shared/types.ts';

type Listener = (sessionId: string, kind: AttentionKind | null) => void;

class AttentionStore {
  private map = new Map<string, AttentionKind>();
  private listeners = new Set<Listener>();

  /** Latest-wins: the most recent event is the current state. needs_input
   *  persists until the user responds (the turn stays blocked, so no later
   *  done/error overwrites it); once a turn ends, done/error correctly
   *  supersedes a now-stale needs_input. */
  set(sessionId: string, kind: AttentionKind): void {
    if (!sessionId) return;
    if (this.map.get(sessionId) === kind) return;  // no-op, don't spam listeners
    this.map.set(sessionId, kind);
    this.emit(sessionId, kind);
  }

  clear(sessionId: string): void {
    if (!sessionId || !this.map.has(sessionId)) return;
    this.map.delete(sessionId);
    this.emit(sessionId, null);
  }

  get(sessionId: string): AttentionKind | null {
    return this.map.get(sessionId) ?? null;
  }

  /** Snapshot { sessionId → kind } for the REST sessions list. */
  all(): Record<string, AttentionKind> {
    return Object.fromEntries(this.map);
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(sessionId: string, kind: AttentionKind | null): void {
    for (const l of this.listeners) {
      try { l(sessionId, kind); } catch { /* ignore */ }
    }
  }
}

export const attentionStore = new AttentionStore();
