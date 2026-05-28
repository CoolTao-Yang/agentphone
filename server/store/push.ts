// Persistent push-subscription store.
//
// Each PWA / APK installation that opts in to push notifications uploads a
// PushSubscription (the browser's serialized endpoint + crypto keys) via
// POST /api/push/subscribe. We store every unique endpoint so that when a
// turn finishes the server can web-push to all of them in parallel.
//
// Storage: JSON file at ~/.config/agentphone/push-subs.json. Serialized
// writes (chain on writePromise) so concurrent subscribe POSTs can't lose
// each other.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PATH = join(homedir(), '.config', 'agentphone', 'push-subs.json');

export type PushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  // Optional: identifies which device this is so the UI can show "📱 iPhone"
  // and the user can revoke individual devices later.
  deviceLabel?: string;
  createdAt: number;
};

type SubsFile = {
  /** Keyed by `endpoint` so the same browser re-subscribing dedupes. */
  byEndpoint: Record<string, PushSubscription>;
};

class PushStore {
  private cache: SubsFile | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  async load(): Promise<SubsFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.byEndpoint && typeof parsed.byEndpoint === 'object') {
        this.cache = parsed as SubsFile;
        return this.cache;
      }
    } catch { /* file missing — start fresh */ }
    this.cache = { byEndpoint: {} };
    return this.cache;
  }

  async upsert(sub: PushSubscription): Promise<void> {
    const file = await this.load();
    file.byEndpoint[sub.endpoint] = sub;
    await this.flush(file);
  }

  async delete(endpoint: string): Promise<void> {
    const file = await this.load();
    if (!(endpoint in file.byEndpoint)) return;
    delete file.byEndpoint[endpoint];
    await this.flush(file);
  }

  async all(): Promise<PushSubscription[]> {
    const file = await this.load();
    return Object.values(file.byEndpoint);
  }

  async count(): Promise<number> {
    const file = await this.load();
    return Object.keys(file.byEndpoint).length;
  }

  private flush(file: SubsFile): Promise<void> {
    this.writePromise = this.writePromise.then(async () => {
      await mkdir(dirname(PATH), { recursive: true });
      await writeFile(PATH, JSON.stringify(file, null, 2), 'utf8');
    });
    return this.writePromise;
  }
}

export const pushStore = new PushStore();
