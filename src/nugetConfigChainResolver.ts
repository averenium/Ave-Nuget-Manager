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
    return { filePath, sources: [], parseError: String(err) };
  }

  try {
    return { filePath, sources: extractSources(content, filePath) };
  } catch (err) {
    return { filePath, sources: [], parseError: String(err) };
  }
}

/**
 * Extract package sources from the XML content of a nuget.config file.
 * Uses regex-based parsing (no DOM dependency in the extension host).
 */
export function extractSources(xml: string, filePath: string): PackageSource[] {
  const sources: PackageSource[] = [];

  // Collect disabled source keys
  const disabledSet = new Set<string>();
  const disabledSection = extractSection(xml, 'disabledPackageSources');
  const addKeyValueRegex = /<add\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"/gi;

  let m: RegExpExecArray | null;
  while ((m = addKeyValueRegex.exec(disabledSection)) !== null) {
    if (m[2].toLowerCase() === 'true') {
      disabledSet.add(m[1]);
    }
  }

  // Collect package sources
  const sourcesSection = extractSection(xml, 'packageSources');
  addKeyValueRegex.lastIndex = 0;

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

/**
 * Extract the inner content of an XML section by tag name.
 * Returns an empty string if the section is absent.
 */
function extractSection(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = regex.exec(xml);
  return m ? m[1] : '';
}
