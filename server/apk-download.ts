// Fetches the latest successful "Build Android APK" GitHub Actions
// artifact and serves the .apk binary directly. Saves the user from:
//   1. Browsing to github.com → Actions → drilling into the latest run.
//   2. Downloading a .zip → unzipping → finding the .apk → moving it
//      to their phone via some side channel.
//
// Now the user just hits  http://<tailscale-ip>:8765/api/download-apk
// from their phone browser and Android offers to install.
//
// Auth: we read the PAT from ~/.config/gh/hosts.yml (gh CLI stores it
// there after `gh auth login`). For deploys without gh CLI, set
// GH_TOKEN or GITHUB_TOKEN. Without any token the GitHub Actions
// artifacts API returns 404, so we surface that.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const REPO_OWNER = 'CoolTao-Yang';
const REPO_NAME = 'agentphone';
const WORKFLOW_FILE = 'build-apk.yml';
const CACHE_DIR = join(tmpdir(), 'agentphone-apk-cache');
const META_FILE = join(CACHE_DIR, 'latest.json');
// How often we ask GitHub "is there a newer build?" before just serving
// the cached APK. 60s is short enough that a fresh push reaches the user
// within a couple minutes after CI finishes (CI itself takes ~3-4 min).
const RUN_CHECK_TTL_MS = 60_000;

export interface ApkInfo {
  runNumber: number;
  runId: number;
  sha: string;
  shortSha: string;
  commitMessage: string;
  builtAt: string;     // ISO timestamp
  apkPath: string;
  size: number;        // bytes
}

let ghTokenCache: string | null | undefined = undefined;
let cachedInfo: ApkInfo | null = null;
let lastRunCheck = 0;
let inflightFetch: Promise<ApkInfo> | null = null;

function loadGhToken(): string | null {
  if (ghTokenCache !== undefined) return ghTokenCache;
  const envTok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envTok) { ghTokenCache = envTok; return envTok; }
  try {
    const path = join(homedir(), '.config', 'gh', 'hosts.yml');
    const raw = readFileSync(path, 'utf8');
    // Match either format gh writes: under a github.com: block, or in a
    // top-level oauth_token field on minimal configs.
    const m = raw.match(/oauth_token:\s*([A-Za-z0-9_-]+)/);
    if (m) { ghTokenCache = m[1]; return m[1]; }
  } catch { /* fall through */ }
  ghTokenCache = null;
  return null;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentphone-server',
  };
  const tok = loadGhToken();
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

async function ghFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const merged: RequestInit = {
    ...init,
    headers: { ...ghHeaders(), ...((init.headers as Record<string, string>) || {}) },
  };
  return fetch(url, merged);
}

async function getLatestSuccessfulRun(): Promise<{
  id: number; run_number: number; head_sha: string;
  head_commit: { message: string }; updated_at: string;
} | null> {
  const url =
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}` +
    `/actions/workflows/${WORKFLOW_FILE}/runs?status=success&per_page=1`;
  const r = await ghFetch(url);
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status}: ${await r.text().catch(() => '')}`);
  }
  const data = await r.json() as { workflow_runs?: any[] };
  return data.workflow_runs?.[0] || null;
}

async function getRunArtifact(runId: number): Promise<{ id: number; name: string } | null> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/artifacts`;
  const r = await ghFetch(url);
  if (!r.ok) {
    throw new Error(`GitHub artifacts API ${r.status}: ${await r.text().catch(() => '')}`);
  }
  const data = await r.json() as { artifacts?: { id: number; name: string }[] };
  return data.artifacts?.find((a) => a.name.startsWith('agentphone-debug-')) || null;
}

async function downloadArtifactZip(artifactId: number): Promise<Buffer> {
  // GitHub returns a 302 redirect to a signed Azure URL. fetch follows by
  // default, but the signed URL responds with the actual zip bytes.
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts/${artifactId}/zip`;
  const r = await ghFetch(url, { redirect: 'follow' });
  if (!r.ok) {
    throw new Error(`GitHub artifact zip ${r.status}: ${await r.text().catch(() => '')}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function loadDiskCache(): ApkInfo | null {
  try {
    if (!existsSync(META_FILE)) return null;
    const meta = JSON.parse(readFileSync(META_FILE, 'utf8')) as ApkInfo;
    if (!existsSync(meta.apkPath)) return null;
    return meta;
  } catch { return null; }
}

/**
 * Returns the latest successful APK. Caches one extracted .apk in
 * /tmp/agentphone-apk-cache/ keyed by run number; re-fetches when GitHub
 * reports a newer successful run.
 *
 * Concurrent requests collapse into one in-flight fetch.
 */
export async function getLatestApk(): Promise<ApkInfo> {
  if (inflightFetch) return inflightFetch;

  // Fast path: in-memory cache + recent run-check.
  if (cachedInfo && Date.now() - lastRunCheck < RUN_CHECK_TTL_MS) {
    return cachedInfo;
  }
  if (!cachedInfo) cachedInfo = loadDiskCache();

  inflightFetch = (async (): Promise<ApkInfo> => {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const run = await getLatestSuccessfulRun();
      if (!run) throw new Error('no successful "Build Android APK" run yet');

      lastRunCheck = Date.now();
      if (cachedInfo &&
          cachedInfo.runNumber === run.run_number &&
          existsSync(cachedInfo.apkPath)) {
        return cachedInfo;
      }

      const artifact = await getRunArtifact(run.id);
      if (!artifact) throw new Error('latest run has no APK artifact (build may have failed mid-step)');

      const zipBuf = await downloadArtifactZip(artifact.id);
      const zip = new AdmZip(zipBuf);
      const apkEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.apk'));
      if (!apkEntry) throw new Error('artifact zip does not contain a .apk file');

      const apkPath = join(CACHE_DIR, `agentphone-${run.run_number}-${run.head_sha.slice(0, 7)}.apk`);
      writeFileSync(apkPath, apkEntry.getData());

      const info: ApkInfo = {
        runNumber: run.run_number,
        runId: run.id,
        sha: run.head_sha,
        shortSha: run.head_sha.slice(0, 7),
        commitMessage: (run.head_commit?.message || '').split('\n')[0],
        builtAt: run.updated_at,
        apkPath,
        size: statSync(apkPath).size,
      };
      writeFileSync(META_FILE, JSON.stringify(info, null, 2));
      cachedInfo = info;
      return info;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

export function getCachedApkInfo(): ApkInfo | null {
  return cachedInfo || loadDiskCache();
}

export function hasGhToken(): boolean {
  return !!loadGhToken();
}
