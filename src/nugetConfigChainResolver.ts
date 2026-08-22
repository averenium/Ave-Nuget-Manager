import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { NuGetConfigFile, PackageSource } from './types';

/**
 * Returns the platform-specific directory where the global NuGet.Config lives.
 *
 * Windows : %APPDATA%\NuGet
 * macOS   : ~/.config/NuGet  (also checks ~/.nuget/NuGet for legacy)
 * Linux   : ~/.config/NuGet  (also checks ~/.nuget/NuGet for legacy)
 */
export function getGlobalNuGetConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'NuGet');
  }
  return path.join(os.homedir(), '.config', 'NuGet');
}

/** Secondary (legacy) global config location used on Linux/macOS. */
function getLegacyGlobalNuGetConfigDir(): string {
  return path.join(os.homedir(), '.nuget', 'NuGet');
}

export class NuGetConfigChainResolver {
  /**
   * Traverse directories upward from `startDir` collecting all `nuget.config`
   * files (case-insensitive name match) found along the way, in nearest-first
   * order.  Stops at the filesystem root or the global NuGet config directory.
   * Appends the global config file if not already in the chain.
   *
   * Property 16: returns exactly the config files along the upward path, no duplicates.
   * Property 18: order is nearest (index 0) → farthest (global).
   */
  async resolve(startDir: string): Promise<NuGetConfigFile[]> {
    const chain: NuGetConfigFile[] = [];
    const seenPaths = new Set<string>();
    const globalDir = getGlobalNuGetConfigDir();
    const legacyDir = getLegacyGlobalNuGetConfigDir();
    const root = path.parse(startDir).root;

    let current = path.resolve(startDir);

    while (true) {
      const candidate = await this._findNuGetConfig(current);
      if (candidate && !seenPaths.has(candidate)) {
        seenPaths.add(candidate);
        chain.push(await parseNuGetConfig(candidate));
      }

      if (current === root) break;

      // Stop after processing the global config directory
      const normalised = path.normalize(current);
      if (
        normalised === path.normalize(globalDir) ||
        normalised === path.normalize(legacyDir)
      ) {
        break;
      }

      const parent = path.dirname(current);
      if (parent === current) break; // filesystem root reached
      current = parent;
    }

    // Append global config if not already included
    await this._appendGlobalConfig(chain, seenPaths, globalDir);
    await this._appendGlobalConfig(chain, seenPaths, legacyDir);

    return chain;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Looks for 'nuget.config' (case-insensitive) in the given directory. */
  private async _findNuGetConfig(dir: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return null;
    }
    const match = entries.find((e) => e.toLowerCase() === 'nuget.config');
    return match ? path.join(dir, match) : null;
  }

  private async _appendGlobalConfig(
    chain: NuGetConfigFile[],
    seenPaths: Set<string>,
    dir: string,
  ): Promise<void> {
    // The file may be named 'NuGet.Config' or 'nuget.config'
    const candidate = await this._findNuGetConfig(dir);
    if (candidate && !seenPaths.has(candidate)) {
      seenPaths.add(candidate);
      chain.push(await parseNuGetConfig(candidate));
    }
  }
}

/**
 * Parse a single `nuget.config` file and return its sources.
 * On any read/parse error, `parseError` is set and `sources` is [].
 */
export async function parseNuGetConfig(filePath: string): Promise<NuGetConfigFile> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    return { filePath, sources: [], auditSources: [], parseError: String(err) };
  }

  try {
    return {
      filePath,
      sources: extractSources(content, filePath),
      ...extractAuditSources(content, filePath),
    };
  } catch (err) {
    return { filePath, sources: [], auditSources: [], parseError: String(err) };
  }
}

/**
 * Extract package sources from the XML content of a nuget.config file.
 * Uses regex-based parsing (no DOM dependency in the extension host).
 */
function disabledPackageSourceKeys(xml: string): Set<string> {
  const disabledSet = new Set<string>();
  const disabledSection = extractSection(xml, 'disabledPackageSources');
  const addKeyValueRegex = /<add\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = addKeyValueRegex.exec(disabledSection)) !== null) {
    if (m[2].toLowerCase() === 'true') {
      disabledSet.add(m[1]);
    }
  }
  return disabledSet;
}

export function extractSources(xml: string, filePath: string): PackageSource[] {
  const sources: PackageSource[] = [];
  const disabledSet = disabledPackageSourceKeys(xml);
  const addKeyValueRegex = /<add\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/gi;
  const sourcesSection = extractSection(xml, 'packageSources');
  let m: RegExpExecArray | null;
  while ((m = addKeyValueRegex.exec(sourcesSection)) !== null) {
    const name = m[1];
    const url = m[2];
    sources.push({
      name,
      url,
      enabled: !disabledSet.has(name),
      configFilePath: filePath,
    });
  }
  return sources;
}

export function extractAuditSources(
  xml: string,
  filePath: string,
): { auditSources: PackageSource[]; auditSourcesCleared: boolean } {
  const section = extractSection(xml, 'auditSources');
  const cleared = /<clear\s*\/>/i.test(section);
  const disabledSet = disabledPackageSourceKeys(xml);
  const sources: PackageSource[] = [];
  const addKeyValueRegex = /<add\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = addKeyValueRegex.exec(section)) !== null) {
    sources.push({
      name: m[1],
      url: m[2],
      enabled: !disabledSet.has(m[1]),
      configFilePath: filePath,
    });
  }
  return { auditSources: sources, auditSourcesCleared: cleared };
}

/** Nearest-first unique enabled package sources (same rule as Sources tab). */
export function uniqueEnabledPackageSources(chain: NuGetConfigFile[]): PackageSource[] {
  const seen = new Set<string>();
  const out: PackageSource[] = [];
  for (const file of chain) {
    for (const src of file.sources) {
      const key = src.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (src.enabled) out.push(src);
    }
  }
  return out;
}

/** Nearest-first audit sources; `<clear />` stops walking farther files. */
export function uniqueEnabledAuditSources(chain: NuGetConfigFile[]): PackageSource[] {
  const seen = new Set<string>();
  const out: PackageSource[] = [];
  for (const file of chain) {
    for (const src of file.auditSources ?? []) {
      const key = src.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (src.enabled) out.push(src);
    }
    if (file.auditSourcesCleared) break;
  }
  return out;
}

/**
 * Extract the inner content of an XML section by tag name.
 * Returns an empty string if the section is absent.
 */
function extractSection(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = regex.exec(xml);
  return m ? m[1] : '';
}
