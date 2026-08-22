import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ImplicitPackage, InstalledPackage, VulnerabilityFinding, VulnerabilitySeverity } from './types';
import { advisoryIdFromUrl, mergeFindings } from './vulnerabilities';
import { versionInNuGetRange } from './nugetVersionRange';

const MAX_LIST = 2_000;
const MAX_PARSE = 400;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_DEPTH = 6;
const PEEK_BYTES = 512;

export interface VdbAdvisory {
  url: string;
  severity: VulnerabilitySeverity;
  versions: string;
}

export type VdbPage = Record<string, VdbAdvisory[]>;

export function defaultNuGetHttpCacheDir(): string {
  return nugetHttpCacheDirs()[0] ?? path.join(os.homedir(), '.local', 'share', 'NuGet', 'v3-cache');
}

/**
 * NuGet HTTP cache locations. Docs say `~/.local/share/...` on Unix; macOS and
 * some clients also use `~/Library/Caches` or `~/.cache`. Use every dir that exists.
 */
export function nugetHttpCacheDirs(): string[] {
  const out: string[] = [];
  const add = (dir: string | undefined) => {
    const d = dir?.trim();
    if (!d) return;
    if (out.includes(d)) return;
    out.push(d);
  };
  add(process.env.NUGET_HTTP_CACHE_PATH);
  if (process.platform === 'win32') {
    add(path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'NuGet', 'v3-cache'));
  } else {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      add(path.join(home, 'Library', 'Caches', 'NuGet', 'v3-cache'));
      add(path.join(home, 'Library', 'Caches', 'NuGet', 'http-cache'));
    }
    add(process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, 'NuGet', 'v3-cache') : undefined);
    add(path.join(home, '.cache', 'NuGet', 'v3-cache'));
    add(path.join(home, '.local', 'share', 'NuGet', 'v3-cache'));
  }
  const existing = out.filter((d) => {
    try {
      return fsSync.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  return existing.length > 0 ? existing : out.slice(0, 1);
}

function severityFromInt(n: number): VulnerabilitySeverity {
  switch (n) {
    case 0: return 'low';
    case 1: return 'moderate';
    case 2: return 'high';
    case 3: return 'critical';
    default: return 'unknown';
  }
}

export function isVulnerabilityIndexJson(json: unknown): json is Array<{ '@id'?: string; '@name'?: string }> {
  if (!Array.isArray(json) || json.length === 0 || json.length > 16) return false;
  return json.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return typeof rec['@name'] === 'string' && typeof rec['@id'] === 'string';
  });
}

/**
 * Package-id → advisories. Unknown keys that are not arrays are skipped
 * (service-index extras, comments) instead of rejecting the whole file.
 */
export function parseVulnerabilityPage(json: unknown): VdbPage | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const rec = json as Record<string, unknown>;
  const page: VdbPage = {};
  let any = false;
  for (const [id, value] of Object.entries(rec)) {
    if (!Array.isArray(value)) continue;
    const advisories: VdbAdvisory[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.url !== 'string' || typeof row.versions !== 'string') continue;
      const sev = typeof row.severity === 'number' ? severityFromInt(row.severity) : 'unknown';
      advisories.push({ url: row.url, versions: row.versions, severity: sev });
    }
    if (advisories.length === 0) continue;
    page[id.toLowerCase()] = advisories;
    any = true;
  }
  return any ? page : undefined;
}

export function looksLikeVdbPayload(text: string): boolean {
  const s = text.trimStart();
  if (s.startsWith('[')) return s.includes('"@name"') && s.includes('"@id"');
  if (s.startsWith('{')) return /"severity"/.test(s) && /"versions"/.test(s);
  return false;
}

interface CacheFile {
  full: string;
  size: number;
  prefer: boolean;
}

async function collectCandidateFiles(root: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_LIST) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_LIST) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }
        if (size === 0 || size > MAX_BYTES) continue;
        out.push({ full, size, prefer: /vulnerabilit/i.test(full) });
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => {
    if (a.prefer !== b.prefer) return a.prefer ? -1 : 1;
    return b.size - a.size;
  });
  return out;
}

export async function loadVdbPagesFromHttpCache(cacheDir: string | string[]): Promise<VdbPage[]> {
  const dirs = Array.isArray(cacheDir) ? cacheDir : [cacheDir];
  const pages: VdbPage[] = [];
  let parsed = 0;
  for (const dir of dirs) {
    const files = await collectCandidateFiles(dir);
    for (const file of files) {
      if (parsed >= MAX_PARSE) return pages;
      let text: string;
      try {
        const fh = await fs.open(file.full, 'r');
        let peek: string;
        try {
          const buf = Buffer.alloc(Math.min(PEEK_BYTES, file.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          peek = buf.toString('utf8', 0, bytesRead);
        } finally {
          await fh.close();
        }
        if (!file.prefer && !looksLikeVdbPayload(peek)) continue;
        text = file.size <= PEEK_BYTES ? peek : await fs.readFile(file.full, 'utf8');
      } catch {
        continue;
      }
      parsed++;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      if (isVulnerabilityIndexJson(json)) continue;
      const page = parseVulnerabilityPage(json);
      if (page) pages.push(page);
    }
  }
  return pages;
}

export function matchVdbPages(
  pages: VdbPage[],
  installed: InstalledPackage[],
  implicit: ImplicitPackage[],
): VulnerabilityFinding[] {
  const pkgs = [
    ...installed.map((p) => ({ id: p.id, version: p.resolvedVersion })),
    ...implicit.map((p) => ({ id: p.id, version: p.resolvedVersion })),
  ];
  const merged: VdbPage = {};
  for (const page of pages) {
    for (const [id, advisories] of Object.entries(page)) {
      merged[id] = [...(merged[id] ?? []), ...advisories];
    }
  }

  const findings: VulnerabilityFinding[] = [];
  for (const pkg of pkgs) {
    const advisories = merged[pkg.id.toLowerCase()];
    if (!advisories) continue;
    for (const adv of advisories) {
      if (!versionInNuGetRange(pkg.version, adv.versions)) continue;
      findings.push({
        packageId: pkg.id,
        version: pkg.version,
        severity: adv.severity,
        id: advisoryIdFromUrl(adv.url),
        url: adv.url,
        source: 'nuget-cache',
      });
    }
  }
  return mergeFindings([findings]);
}

export async function findingsFromNuGetHttpCache(
  cacheDir: string | string[],
  installed: InstalledPackage[],
  implicit: ImplicitPackage[],
): Promise<VulnerabilityFinding[]> {
  const pages = await loadVdbPagesFromHttpCache(cacheDir);
  return matchVdbPages(pages, installed, implicit);
}
