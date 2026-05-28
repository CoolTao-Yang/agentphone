// Persistent link map: phone-owned session ID → external CLI session ID.
//
// Used by the Phase 3 mirror feature. When a phone-owned session completes a
// turn and the LinkStore has an entry for it, the runner appends a mirror
// summary into the linked external jsonl so the desktop CLI sees what was
// chatted on the phone.
//
// Storage: JSON object in ~/.config/agentphone/links.json. Tiny, no
// concurrency model beyond "process owns the file" since agentphone is the
// only writer.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'agentphone');
const LINKS_PATH = join(CONFIG_DIR, 'links.json');

type LinksFile = Record<string, string>;  // phoneSid → externalSid

class LinkStore {
  private cache: LinksFile | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  async load(): Promise<LinksFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(LINKS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.cache = parsed as LinksFile;
        return this.cache;
      }
    } catch {
      // file missing or unreadable — start fresh
    }
    this.cache = {};
    return this.cache;
  }

  async link(phoneSid: string, externalSid: string): Promise<void> {
    const links = await this.load();
    links[phoneSid] = externalSid;
    await this.flush(links);
  }

  async unlink(phoneSid: string): Promise<void> {
    const links = await this.load();
    if (!(phoneSid in links)) return;
    delete links[phoneSid];
    await this.flush(links);
  }

  async externalFor(phoneSid: string): Promise<string | null> {
    const links = await this.load();
    return links[phoneSid] ?? null;
  }

  async phonesFor(externalSid: string): Promise<string[]> {
    const links = await this.load();
    const out: string[] = [];
    for (const [phone, ext] of Object.entries(links)) {
      if (ext === externalSid) out.push(phone);
    }
    return out;
  }

  /** Serialized writes — chain on the previous promise so two callers can't
   *  race on the file. */
  private flush(links: LinksFile): Promise<void> {
    this.writePromise = this.writePromise.then(async () => {
      await mkdir(dirname(LINKS_PATH), { recursive: true });
      const json = JSON.stringify(links, null, 2);
      await writeFile(LINKS_PATH, json, 'utf8');
    });
    return this.writePromise;
  }
}

export const linkStore = new LinkStore();
