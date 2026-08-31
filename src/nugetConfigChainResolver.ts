import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { NuGetConfigFile, PackageSource, PackageSourceMapping } from './types';
import { normalizeFsPath } from './pathCompare';
import { extractApiKeyUrls, extractCredentialUsernames, unescapeXml } from './nugetConfigEdit';
import { decodeXmlLocalName } from './nugetConfigXmlName';

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
export function getLegacyGlobalNuGetConfigDir(): string {
  return path.join(os.homedir(), '.nuget', 'NuGet');
}

export function nugetConfigGlobalDirs(): string[] {
  return [getGlobalNuGetConfigDir(), getLegacyGlobalNuGetConfigDir()];
}

export function isGlobalNuGetConfigPath(filePath: string): boolean {
  const n = normalizeFsPath(filePath);
  return nugetConfigGlobalDirs().some((dir) => {
    const nd = normalizeFsPath(dir);
    return n === nd || n.startsWith(`${nd}/`);
  });
}

/**
 * VS Code glob search / asRelativePath may not keep on-disk filename case on Windows.
 * Readdir the parent and join the matching entry.
 */
export async function trueCaseFilePath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const names = await fs.readdir(dir);
    if (!Array.isArray(names)) return filePath;
    const hit = names.find((n) => typeof n === 'string' && n.toLowerCase() === base.toLowerCase());
    return hit ? path.join(dir, hit) : filePath;
  } catch {
    return filePath;
  }
}

/**
 * Computer-level config directory (lowest precedence after user + walk-up).
 * `NUGET_COMMON_APPLICATION_DATA/NuGet/Config` overrides the platform default.
 */
export function getMachineWideNuGetConfigDir(): string {
  const override = process.env.NUGET_COMMON_APPLICATION_DATA || process.env.NUGET_COMMON_APPLICATION_DATA;
  if (override) return path.join(override, 'NuGet', 'Config');
  if (process.platform === 'win32') {
    const x86 = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles ?? 'C:\\Program Files (x86)';
    return path.join(x86, 'NuGet', 'Config');
  }
  if (process.platform === 'darwin') {
    return path.join('/Library', 'Application Support', 'NuGet', 'Config');
  }
  return path.join('/etc', 'opt', 'NuGet', 'Config');
}

export function isMachineWideNuGetConfigPath(filePath: string): boolean {
  const n = normalizeFsPath(filePath);
  const nd = normalizeFsPath(getMachineWideNuGetConfigDir());
  return n === nd || n.startsWith(`${nd}/`);
}

async function listMachineWideNuGetConfigFiles(): Promise<string[]> {
  const root = getMachineWideNuGetConfigDir();
  const out: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const name of names) {
      const full = path.join(dir, name);
      if (name.toLowerCase().endsWith('.config')) {
        out.push(full);
        continue;
      }
      dirs.push(full);
    }
    for (const sub of dirs.sort((a, b) => a.localeCompare(b))) {
      await walk(sub, depth + 1);
    }
  };

  await walk(root, 0);
  out.sort((a, b) => a.localeCompare(b));
  return out;
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
    await this._appendMachineWideConfigs(chain, seenPaths);

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

  private async _appendMachineWideConfigs(
    chain: NuGetConfigFile[],
    seenPaths: Set<string>,
  ): Promise<void> {
    const files = await listMachineWideNuGetConfigFiles();
    for (const filePath of files) {
      const key = path.normalize(filePath);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const parsed = await parseNuGetConfig(filePath);
      parsed.isMachineWide = true;
      chain.push(parsed);
    }
  }
}

/**
 * Parse a single `nuget.config` file and return its sources.
 * On any read/parse error, `parseError` is set and `sources` is [].
 */
export async function parseNuGetConfig(filePath: string, xml?: string): Promise<NuGetConfigFile> {
  const actualPath = await trueCaseFilePath(filePath);
  const machine = isMachineWideNuGetConfigPath(actualPath);
  let content = xml;
  if (content === undefined) {
    try {
      content = await fs.readFile(actualPath, 'utf-8');
    } catch (err) {
      return { filePath: actualPath, sources: [], auditSources: [], credentialKeys: [], parseError: String(err), isMachineWide: machine };
    }
  }
  return parseNuGetConfigXml(actualPath, content);
}

/** Parse nuget.config XML already in memory (open editor buffer). */
export function parseNuGetConfigXml(filePath: string, content: string): NuGetConfigFile {
  const machine = isMachineWideNuGetConfigPath(filePath);
  try {
    const pkg = extractPackageSources(content, filePath);
    const disabled = extractDisabledPackageSources(content);
    const mapping = extractPackageSourceMapping(content);
    return {
      filePath,
      sources: pkg.sources,
      packageSourcesCleared: pkg.packageSourcesCleared,
      credentialKeys: extractCredentialKeys(content),
      credentialUsernames: extractCredentialUsernames(content),
      apiKeyUrls: extractApiKeyUrls(content),
      disabledPackageSources: disabled.entries,
      disabledPackageSourcesCleared: disabled.cleared,
      packageSourceMapping: mapping.mappings,
      packageSourceMappingCleared: mapping.cleared,
      isMachineWide: machine,
      ...extractAuditSources(content, filePath),
    };
  } catch (err) {
    return { filePath, sources: [], auditSources: [], credentialKeys: [], parseError: String(err), isMachineWide: machine };
  }
}

/**
 * Extract package sources from the XML content of a nuget.config file.
 * Uses regex-based parsing (no DOM dependency in the extension host).
 */
function parseAddAttributes(tagInner: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.\-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagInner)) !== null) {
    out[m[1].toLowerCase()] = unescapeXml(m[2]);
  }
  return out;
}

function isTrueAttr(attrs: Record<string, string>, name: string): boolean {
  return attrs[name.toLowerCase()]?.toLowerCase() === 'true';
}

function sourceFromAddTag(tagInner: string, filePath: string, disabledSet: Set<string>): PackageSource | undefined {
  const attrs = parseAddAttributes(tagInner);
  const name = attrs.key;
  if (!name || attrs.value === undefined) return undefined;
  const src: PackageSource = {
    name,
    url: attrs.value,
    enabled: !disabledSet.has(name.toLowerCase()),
    configFilePath: filePath,
  };
  if (isTrueAttr(attrs, 'allowinsecureconnections')) src.allowInsecureConnections = true;
  if (
    isTrueAttr(attrs, 'disabletlscertificatevalidation')
    || isTrueAttr(attrs, 'disabletlsverification')
    || isTrueAttr(attrs, 'disabletlscertificateverification')
  ) {
    src.disableTlsCertificateValidation = true;
  }
  const protocol = attrs.protocolversion?.trim();
  if (protocol === '2' || protocol === '3') src.protocolVersion = protocol;
  return src;
}

function extractSourceAdds(section: string, filePath: string, disabledSet: Set<string>): PackageSource[] {
  const sources: PackageSource[] = [];
  const tagRe = /<add\b([^>]*?)\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(section)) !== null) {
    const src = sourceFromAddTag(m[1], filePath, disabledSet);
    if (src) sources.push(src);
  }
  return sources;
}

function disabledPackageSourceKeys(xml: string): Set<string> {
  const disabledSet = new Set<string>();
  for (const entry of extractDisabledPackageSources(xml).entries) {
    if (entry.disabled) disabledSet.add(entry.name.toLowerCase());
  }
  return disabledSet;
}

/** Entries from `<disabledPackageSources>`, including explicit `value="false"` re-enables. */
export function extractDisabledPackageSources(
  xml: string,
): { entries: Array<{ name: string; disabled: boolean }>; cleared: boolean } {
  const section = extractSection(xml, 'disabledPackageSources');
  const entries: Array<{ name: string; disabled: boolean }> = [];
  const tagRe = /<add\b([^>]*?)\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(section)) !== null) {
    const attrs = parseAddAttributes(m[1]);
    if (!attrs.key) continue;
    const value = (attrs.value ?? 'true').toLowerCase();
    entries.push({ name: attrs.key, disabled: value !== 'false' });
  }
  return { entries, cleared: /<clear\s*\/>/i.test(section) };
}

/** `<packageSourceMapping>` for one file. Same source key keeps the last pattern list. */
export function extractPackageSourceMapping(
  xml: string,
): { mappings: PackageSourceMapping[]; cleared: boolean } {
  const section = extractSection(xml, 'packageSourceMapping');
  const byKey = new Map<string, PackageSourceMapping>();
  const blockRe = /<packageSource\b([^>]*)>([\s\S]*?)<\/packageSource>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(section)) !== null) {
    const sourceName = parseAddAttributes(m[1]).key;
    if (!sourceName) continue;
    const patterns: string[] = [];
    const patRe = /<package\b([^>]*?)\s*\/?>/gi;
    let p: RegExpExecArray | null;
    while ((p = patRe.exec(m[2])) !== null) {
      const pattern = parseAddAttributes(p[1]).pattern;
      if (pattern) patterns.push(pattern);
    }
    byKey.set(sourceName.toLowerCase(), { sourceName, patterns });
  }
  return { mappings: [...byKey.values()], cleared: /<clear\s*\/>/i.test(section) };
}

/**
 * Effective disabled source names (lowercase). Walks farthest → nearest.
 * `<clear />` wipes parent disables; `value="false"` re-enables a farther disable.
 */
export function mergedDisabledSourceNames(chain: NuGetConfigFile[]): Set<string> {
  const disabled = new Set<string>();
  for (let i = chain.length - 1; i >= 0; i--) {
    const file = chain[i];
    if (file.disabledPackageSourcesCleared) disabled.clear();
    for (const entry of file.disabledPackageSources ?? []) {
      const key = entry.name.toLowerCase();
      if (entry.disabled) disabled.add(key);
      else disabled.delete(key);
    }
  }
  return disabled;
}

/**
 * Effective `<packageSourceMapping>`. Empty means mapping is off.
 * `<clear />` wipes parent mappings; the same source key replaces that source's patterns.
 */
export function mergedPackageSourceMapping(chain: NuGetConfigFile[]): PackageSourceMapping[] {
  const byKey = new Map<string, PackageSourceMapping>();
  for (let i = chain.length - 1; i >= 0; i--) {
    const file = chain[i];
    if (file.packageSourceMappingCleared) byKey.clear();
    for (const mapping of file.packageSourceMapping ?? []) {
      byKey.set(mapping.sourceName.toLowerCase(), mapping);
    }
  }
  return [...byKey.values()];
}

function withMergedEnabled(sources: PackageSource[], chain: NuGetConfigFile[]): PackageSource[] {
  const disabled = mergedDisabledSourceNames(chain);
  return sources.map((src) => ({
    ...src,
    enabled: !disabled.has(src.name.toLowerCase()),
  }));
}

export function extractPackageSources(
  xml: string,
  filePath: string,
): { sources: PackageSource[]; packageSourcesCleared: boolean } {
  const sourcesSection = extractSection(xml, 'packageSources');
  return {
    sources: extractSourceAdds(sourcesSection, filePath, disabledPackageSourceKeys(xml)),
    packageSourcesCleared: /<clear\s*\/>/i.test(sourcesSection),
  };
}

export function extractSources(xml: string, filePath: string): PackageSource[] {
  return extractPackageSources(xml, filePath).sources;
}

/** Source keys that have a credentials block. Never returns password values. */
export function extractCredentialKeys(xml: string): string[] {
  const section = extractSection(xml, 'packageSourceCredentials');
  if (!section) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<([^\s/>]+)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(section)) !== null) {
    const tag = m[1];
    if (tag.toLowerCase() === 'add') continue;
    const name = decodeXmlLocalName(tag);
    const id = name.toLowerCase();
    if (id === 'add' || seen.has(id)) continue;
    seen.add(id);
    keys.push(name);
  }
  return keys;
}

export function extractAuditSources(
  xml: string,
  filePath: string,
): { auditSources: PackageSource[]; auditSourcesCleared: boolean } {
  const section = extractSection(xml, 'auditSources');
  return {
    auditSources: extractSourceAdds(section, filePath, disabledPackageSourceKeys(xml)),
    auditSourcesCleared: /<clear\s*\/>/i.test(section),
  };
}

function uniquePackageSourcesFromChain(
  chain: NuGetConfigFile[],
  enabledOnly: boolean,
): PackageSource[] {
  const seen = new Set<string>();
  const out: PackageSource[] = [];
  for (const file of chain) {
    for (const src of file.sources) {
      const key = src.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(src);
    }
    if (file.packageSourcesCleared) break;
  }
  const merged = withMergedEnabled(out, chain);
  return enabledOnly ? merged.filter((src) => src.enabled) : merged;
}

/** Nearest-first unique package sources (includes disabled). `<clear />` stops farther files. */
export function uniquePackageSources(chain: NuGetConfigFile[]): PackageSource[] {
  return uniquePackageSourcesFromChain(chain, false);
}

/** Nearest-first unique enabled package sources. `<clear />` stops farther files. */
export function uniqueEnabledPackageSources(chain: NuGetConfigFile[]): PackageSource[] {
  return uniquePackageSourcesFromChain(chain, true);
}

function collectDeclaredAuditSources(chain: NuGetConfigFile[]): PackageSource[] {
  const seen = new Set<string>();
  const out: PackageSource[] = [];
  for (const file of chain) {
    for (const src of file.auditSources ?? []) {
      const key = src.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(src);
    }
    if (file.auditSourcesCleared) break;
  }
  return out;
}

function uniqueAuditSourcesFromChain(
  chain: NuGetConfigFile[],
  enabledOnly: boolean,
): PackageSource[] {
  const merged = withMergedEnabled(collectDeclaredAuditSources(chain), chain);
  return enabledOnly ? merged.filter((src) => src.enabled) : merged;
}

/**
 * Declared audit feeds in chain order, ignoring `<disabledPackageSources>`.
 * Used when rewriting `<auditSources>` so a package-source disable does not drop the audit add.
 */
export function uniqueDeclaredAuditSources(chain: NuGetConfigFile[]): PackageSource[] {
  return collectDeclaredAuditSources(chain);
}

/**
 * Effective audit rows plus feeds a nearer `<clear />` hid, marked disabled
 * so the Sources tab can turn them back on without `<disabledPackageSources>`.
 */
export function uniqueAuditSourcesWithSuppressed(chain: NuGetConfigFile[]): PackageSource[] {
  const unique = uniqueAuditSourcesFromChain(chain, false);
  const keys = new Set(unique.map((s) => s.name.toLowerCase()));
  const extra: PackageSource[] = [];
  let seenClear = false;
  for (const file of chain) {
    if (seenClear) {
      for (const src of file.auditSources ?? []) {
        const key = src.name.toLowerCase();
        if (keys.has(key)) continue;
        keys.add(key);
        extra.push({ ...src, enabled: false });
      }
    }
    if (file.auditSourcesCleared) seenClear = true;
  }
  return [...unique, ...extra];
}

/** Nearest-first unique audit sources (includes disabled). `<clear />` stops farther files. */
export function uniqueAuditSources(chain: NuGetConfigFile[]): PackageSource[] {
  return uniqueAuditSourcesFromChain(chain, false);
}

/** Nearest-first enabled audit sources; `<clear />` stops walking farther files. */
export function uniqueEnabledAuditSources(chain: NuGetConfigFile[]): PackageSource[] {
  return uniqueAuditSourcesFromChain(chain, true);
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
