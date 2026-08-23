import type {
  ChainChange,
  ConfigChainFileView,
  ConfigConflict,
  EffectiveSourceRow,
  ExtraConfigFileView,
  ExtraConfigRole,
  FeedKind,
  NuGetConfigFile,
  PackageSource,
  PackageSourceMapping,
  SourcesSnapshot,
} from './types';
import { normalizeFsPath } from './pathCompare';
import { isHttpPackageUrl, isOfficialNugetSourceUrl } from './vulnerabilityScanPolicy';
import {
  mergedPackageSourceMapping,
  uniqueAuditSourcesWithSuppressed,
  uniqueEnabledAuditSources,
  uniqueEnabledPackageSources,
  uniquePackageSources,
} from './nugetConfigChainResolver';
import { expandNuGetConfigValue } from './nugetConfigEnv';
import { effectiveProtocolVersion } from './nugetProtocol';

export const EMPTY_SOURCES_SNAPSHOT: SourcesSnapshot = {
  effectivePackageSources: [],
  effectiveAuditSources: [],
  chain: [],
  extraConfigs: [],
  conflicts: [],
  packageSourceMapping: [],
};

export interface ProjectConfigChain {
  projectName: string;
  chain: NuGetConfigFile[];
}

export interface SourcesSnapshotInput {
  scopeChain: NuGetConfigFile[];
  projectChains: ProjectConfigChain[];
  workspaceConfigs: NuGetConfigFile[];
  relativePath: (absPath: string) => string;
  isGlobalPath: (absPath: string) => boolean;
  /** Solution scope compares audit feeds per project. Project scope skips that warning. */
  compareAuditToProjects: boolean;
  extraConfigsTruncated?: boolean;
}

export function normalizeSourceUrl(url: string): string {
  const trimmed = expandNuGetConfigValue(url).trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const path = u.pathname.replace(/\/+$/, '') || '';
      return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
    }
  } catch {
    /* folder / UNC */
  }
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function feedKind(url: string): FeedKind {
  if (isOfficialNugetSourceUrl(url)) {
    try {
      const host = new URL(expandNuGetConfigValue(url).trim()).hostname.toLowerCase();
      if (host === 'data.nuget.org') return 'data.nuget.org';
    } catch {
      /* ignore */
    }
    return 'nuget.org';
  }
  if (isHttpPackageUrl(url)) return 'http';
  return 'local';
}

function pathKey(filePath: string): string {
  return normalizeFsPath(filePath);
}

function displayPathFor(
  filePath: string,
  flags: { isGlobal: boolean; isMachineWide?: boolean },
  relativePath: (absPath: string) => string,
): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  if (flags.isMachineWide || flags.isGlobal) return base;
  const rel = (relativePath(filePath) || filePath).replace(/\\/g, '/');
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? base : `${rel.slice(0, slash + 1)}${base}`;
}

function credentialSet(chain: NuGetConfigFile[]): Set<string> {
  const keys = new Set<string>();
  for (const file of chain) {
    for (const k of file.credentialKeys ?? []) {
      keys.add(k.toLowerCase());
    }
  }
  return keys;
}

function credentialUsername(chain: NuGetConfigFile[], name: string): string | undefined {
  const key = name.toLowerCase();
  for (const file of chain) {
    const map = file.credentialUsernames ?? {};
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() === key && v) return v;
    }
  }
  return undefined;
}

function chainHasApiKey(chain: NuGetConfigFile[], xmlUrl: string): boolean {
  const want = normalizeSourceUrl(xmlUrl);
  for (const file of chain) {
    for (const k of file.apiKeyUrls ?? []) {
      if (normalizeSourceUrl(k) === want) return true;
    }
  }
  return false;
}

function mappingPatternsFor(name: string, mappings: PackageSourceMapping[]): string[] | undefined {
  if (mappings.length === 0) return undefined;
  const hit = mappings.find((m) => m.sourceName.toLowerCase() === name.toLowerCase());
  return hit?.patterns ?? [];
}

function toEffectiveRow(
  src: PackageSource,
  chain: NuGetConfigFile[],
  creds: Set<string>,
  mappings: PackageSourceMapping[],
): EffectiveSourceRow {
  const expanded = expandNuGetConfigValue(src.url);
  return {
    name: src.name,
    url: expanded,
    enabled: src.enabled,
    kind: feedKind(expanded),
    hasCredentials: creds.has(src.name.toLowerCase()),
    username: credentialUsername(chain, src.name),
    hasApiKey: chainHasApiKey(chain, src.url),
    allowInsecureConnections: src.allowInsecureConnections,
    disableTlsCertificateValidation: src.disableTlsCertificateValidation,
    configFilePath: src.configFilePath,
    mappingPatterns: mappingPatternsFor(src.name, mappings),
    urlRaw: expanded !== src.url ? src.url : undefined,
    protocolVersion: effectiveProtocolVersion(expanded, src.protocolVersion),
  };
}

function firstFartherByName(
  chain: NuGetConfigFile[],
  fromIndex: number,
  name: string,
  kind: 'package' | 'audit',
): PackageSource | undefined {
  const key = name.toLowerCase();
  for (let i = fromIndex + 1; i < chain.length; i++) {
    const list = kind === 'package' ? chain[i].sources : (chain[i].auditSources ?? []);
    const hit = list.find((s) => s.name.toLowerCase() === key);
    if (hit) return hit;
    if (kind === 'package' && chain[i].packageSourcesCleared) break;
    if (kind === 'audit' && chain[i].auditSourcesCleared) break;
  }
  return undefined;
}

function nearerFileForName(
  chain: NuGetConfigFile[],
  beforeIndex: number,
  name: string,
  kind: 'package' | 'audit',
): string | undefined {
  const key = name.toLowerCase();
  for (let i = 0; i < beforeIndex; i++) {
    const list = kind === 'package' ? chain[i].sources : (chain[i].auditSources ?? []);
    if (list.some((s) => s.name.toLowerCase() === key)) return chain[i].filePath;
  }
  return undefined;
}

function describeSources(
  file: NuGetConfigFile,
  index: number,
  chain: NuGetConfigFile[],
  kind: 'package' | 'audit',
): ChainChange[] {
  const list = kind === 'package' ? file.sources : (file.auditSources ?? []);
  const cleared = kind === 'package' ? file.packageSourcesCleared : file.auditSourcesCleared;
  const changes: ChainChange[] = [];
  if (cleared) {
    changes.push({ kind: kind === 'package' ? 'cleared-package' : 'cleared-audit', sourceKind: kind });
  }
  for (const src of list) {
    const nearer = nearerFileForName(chain, index, src.name, kind);
    if (nearer) {
      changes.push({
        kind: 'overridden',
        sourceKind: kind,
        name: src.name,
        url: src.url,
        byFilePath: nearer,
      });
      continue;
    }
    const farther = firstFartherByName(chain, index, src.name, kind);
    if (farther && normalizeSourceUrl(farther.url) !== normalizeSourceUrl(src.url)) {
      changes.push({
        kind: 'replaced',
        sourceKind: kind,
        name: src.name,
        url: src.url,
        previousUrl: farther.url,
      });
    } else {
      changes.push({ kind: 'added', sourceKind: kind, name: src.name, url: src.url });
    }
    if (!src.enabled) {
      changes.push({ kind: 'disabled', sourceKind: kind, name: src.name, url: src.url });
    }
  }
  if (kind === 'package') {
    const listed = new Set(list.map((s) => s.name.toLowerCase()));
    for (const entry of file.disabledPackageSources ?? []) {
      if (!entry.disabled) continue;
      if (listed.has(entry.name.toLowerCase())) continue;
      changes.push({ kind: 'disabled', sourceKind: kind, name: entry.name });
    }
  }
  return changes;
}

function sourceRowsForFile(
  file: NuGetConfigFile,
  secretChain: NuGetConfigFile[],
): { packageSources: EffectiveSourceRow[]; auditSources: EffectiveSourceRow[] } {
  const creds = credentialSet(secretChain);
  const mappings = file.packageSourceMapping ?? [];
  return {
    packageSources: file.sources.map((s) => toEffectiveRow(s, secretChain, creds, mappings)),
    auditSources: (file.auditSources ?? []).map((s) => toEffectiveRow(s, secretChain, creds, mappings)),
  };
}

function buildChainViews(input: SourcesSnapshotInput): ConfigChainFileView[] {
  return input.scopeChain.map((file, index) => {
    const isGlobal = input.isGlobalPath(file.filePath);
    const isMachineWide = !!file.isMachineWide;
    const auditDefined = (file.auditSources ?? []).length > 0 || !!file.auditSourcesCleared;
    const rows = sourceRowsForFile(file, input.scopeChain);
    return {
      filePath: file.filePath,
      displayPath: displayPathFor(file.filePath, { isGlobal, isMachineWide }, input.relativePath),
      isGlobal,
      isMachineWide,
      parseError: file.parseError,
      packageChanges: describeSources(file, index, input.scopeChain, 'package'),
      auditChanges: auditDefined ? describeSources(file, index, input.scopeChain, 'audit') : [],
      packageSources: rows.packageSources,
      auditSources: rows.auditSources,
    };
  });
}

function classifyExtra(input: SourcesSnapshotInput): ExtraConfigFileView[] {
  const scopeKeys = new Set(input.scopeChain.map((f) => pathKey(f.filePath)));
  const applies = new Map<string, string[]>();
  for (const project of input.projectChains) {
    for (const file of project.chain) {
      const k = pathKey(file.filePath);
      const names = applies.get(k) ?? [];
      if (!names.includes(project.projectName)) names.push(project.projectName);
      applies.set(k, names);
    }
  }

  const seen = new Set<string>();
  const out: ExtraConfigFileView[] = [];
  for (const file of input.workspaceConfigs) {
    const k = pathKey(file.filePath);
    if (seen.has(k)) continue;
    seen.add(k);
    const isGlobal = input.isGlobalPath(file.filePath);
    const isMachineWide = !!file.isMachineWide;
    let role: ExtraConfigRole;
    if (scopeKeys.has(k)) role = 'on-chain';
    else if ((applies.get(k) ?? []).length > 0) role = 'applies';
    else role = 'dead';
    out.push({
      filePath: file.filePath,
      displayPath: displayPathFor(file.filePath, { isGlobal, isMachineWide }, input.relativePath),
      isGlobal,
      isMachineWide,
      role,
      appliesToProjectNames: applies.get(k) ?? [],
      parseError: file.parseError,
      ...sourceRowsForFile(file, [file, ...input.scopeChain]),
    });
  }
  return out;
}

function applyingFiles(input: SourcesSnapshotInput): NuGetConfigFile[] {
  const map = new Map<string, NuGetConfigFile>();
  for (const file of input.scopeChain) map.set(pathKey(file.filePath), file);
  for (const project of input.projectChains) {
    for (const file of project.chain) map.set(pathKey(file.filePath), file);
  }
  return [...map.values()];
}

function auditFingerprint(sources: PackageSource[]): string {
  return sources
    .map((s) => `${s.name.toLowerCase()}\t${normalizeSourceUrl(s.url)}`)
    .sort()
    .join('\n');
}

function collectConflicts(
  input: SourcesSnapshotInput,
  extra: ExtraConfigFileView[],
): ConfigConflict[] {
  const conflicts: ConfigConflict[] = [];
  const applying = applyingFiles(input);

  const urlsByKey = new Map<string, Map<string, { url: string; files: string[] }>>();
  for (const file of applying) {
    for (const src of file.sources) {
      const key = src.name.toLowerCase();
      const norm = normalizeSourceUrl(src.url);
      let byUrl = urlsByKey.get(key);
      if (!byUrl) {
        byUrl = new Map();
        urlsByKey.set(key, byUrl);
      }
      const slot = byUrl.get(norm) ?? { url: src.url, files: [] };
      if (!slot.files.includes(file.filePath)) slot.files.push(file.filePath);
      byUrl.set(norm, slot);
    }
  }
  for (const [key, byUrl] of urlsByKey) {
    if (byUrl.size <= 1) continue;
    const variants = [...byUrl.values()];
    conflicts.push({
      kind: 'same-key-different-url',
      message: `Source "${key}" maps to different URLs.`,
      filePaths: [...new Set(variants.flatMap((v) => v.files))],
    });
  }

  const chainsToCheck = [
    { name: 'scope', chain: input.scopeChain },
    ...input.projectChains.map((p) => ({ name: p.projectName, chain: p.chain })),
  ];
  const seenUrlKey = new Set<string>();
  for (const { chain } of chainsToCheck) {
    const enabled = uniqueEnabledPackageSources(chain);
    const byUrl = new Map<string, PackageSource[]>();
    for (const src of enabled) {
      const norm = normalizeSourceUrl(src.url);
      const list = byUrl.get(norm) ?? [];
      list.push(src);
      byUrl.set(norm, list);
    }
    for (const [, list] of byUrl) {
      const names = [...new Set(list.map((s) => s.name.toLowerCase()))];
      if (names.length < 2) continue;
      if (list.every((s) => isOfficialNugetSourceUrl(s.url))) continue;
      const sig = `${names.sort().join('|')}@${normalizeSourceUrl(list[0].url)}`;
      if (seenUrlKey.has(sig)) continue;
      seenUrlKey.add(sig);
      conflicts.push({
        kind: 'same-url-different-keys',
        message: `Same feed URL is registered as ${names.map((n) => `"${n}"`).join(' and ')}.`,
        filePaths: [...new Set(list.map((s) => s.configFilePath))],
      });
    }
  }

  const seenClear = new Set<string>();
  const allChains = [input.scopeChain, ...input.projectChains.map((p) => p.chain)];
  for (const chain of allChains) {
    for (let i = 0; i < chain.length; i++) {
      const file = chain[i];
      if (!file.packageSourcesCleared) continue;
      const k = pathKey(file.filePath);
      if (seenClear.has(k)) continue;
      const nearerKeys = new Set(file.sources.map((s) => s.name.toLowerCase()));
      const dropped: PackageSource[] = [];
      for (let j = i + 1; j < chain.length; j++) {
        for (const src of chain[j].sources) {
          const name = src.name.toLowerCase();
          if (!nearerKeys.has(name) && !dropped.some((d) => d.name.toLowerCase() === name)) {
            dropped.push(src);
          }
        }
      }
      // nuget.org / data.nuget.org from Global is the usual private-feed isolation, not a conflict.
      const unexpected = dropped.filter((s) => !isOfficialNugetSourceUrl(s.url));
      if (unexpected.length === 0) continue;
      seenClear.add(k);
      conflicts.push({
        kind: 'clear-drops-parent',
        message: `<clear /> in packageSources drops parent feeds (${unexpected.map((s) => s.name).join(', ')}).`,
        filePaths: [file.filePath],
      });
    }
  }

  if (input.compareAuditToProjects) {
    const scopeFp = auditFingerprint(uniqueEnabledAuditSources(input.scopeChain));
    for (const project of input.projectChains) {
      const fp = auditFingerprint(uniqueEnabledAuditSources(project.chain));
      if (fp === scopeFp) continue;
      conflicts.push({
        kind: 'audit-mismatch',
        message: `Project ${project.projectName} uses different auditSources than the current scope.`,
        filePaths: project.chain.map((c) => c.filePath),
      });
    }
  }

  for (const extraFile of extra) {
    if (extraFile.role !== 'applies') continue;
    const names = extraFile.appliesToProjectNames.join(', ');
    conflicts.push({
      kind: 'off-chain-applies',
      message: `${extraFile.displayPath} is not in the current chain but applies to ${names}.`,
      filePaths: [extraFile.filePath],
    });
  }

  return conflicts;
}

export function buildSourcesSnapshot(input: SourcesSnapshotInput): SourcesSnapshot {
  const creds = credentialSet(input.scopeChain);
  const extraConfigs = classifyExtra(input);
  const mappings = mergedPackageSourceMapping(input.scopeChain);
  return {
    effectivePackageSources: uniquePackageSources(input.scopeChain).map((s) =>
      toEffectiveRow(s, input.scopeChain, creds, mappings),
    ),
    effectiveAuditSources: uniqueAuditSourcesWithSuppressed(input.scopeChain).map((s) =>
      toEffectiveRow(s, input.scopeChain, creds, mappings),
    ),
    chain: buildChainViews(input),
    extraConfigs,
    extraConfigsTruncated: input.extraConfigsTruncated,
    conflicts: collectConflicts(input, extraConfigs),
    packageSourceMapping: mappings,
  };
}
