/**
 * Effective audit toggle: change one key without copying the whole audit
 * chain into the nearest workspace nuget.config (often a git-tracked file).
 */

import type { NuGetConfigFile } from './types';
import {
  isGlobalNuGetConfigPath,
  isMachineWideNuGetConfigPath,
  uniqueAuditSourcesWithSuppressed,
  uniqueDeclaredAuditSources,
} from './nugetConfigChainResolver';
import { pathsEqual } from './pathCompare';

export type AuditConfigEdit =
  | { op: 'remove'; filePath: string; name: string }
  | { op: 'upsert'; filePath: string; name: string; url: string }
  | { op: 'replace'; filePath: string; sources: Array<{ name: string; url: string }>; clear: true };

function isMachineFile(file: NuGetConfigFile): boolean {
  return !!file.isMachineWide || isMachineWideNuGetConfigPath(file.filePath);
}

function hasAuditKey(file: NuGetConfigFile, nameLc: string): boolean {
  return (file.auditSources ?? []).some((s) => s.name.toLowerCase() === nameLc);
}

function stripAuditKey(
  chain: NuGetConfigFile[],
  nameLc: string,
  skip: (file: NuGetConfigFile) => boolean,
): NuGetConfigFile[] {
  return chain.map((file) => {
    if (skip(file)) return file;
    return {
      ...file,
      auditSources: (file.auditSources ?? []).filter((s) => s.name.toLowerCase() !== nameLc),
    };
  });
}

function userConfigPath(chain: NuGetConfigFile[], fallback: string): string {
  return chain.find((f) => pathsEqual(f.filePath, fallback) || isGlobalNuGetConfigPath(f.filePath))?.filePath
    ?? fallback;
}

/**
 * Plan XML edits for an Effective-view audit toggle.
 * File-view (a specific config in the chain) is upsert/remove on that file only.
 */
export function planEffectiveAuditToggle(opts: {
  chain: NuGetConfigFile[];
  name: string;
  enabled: boolean;
  url?: string;
  userConfigPath: string;
}): AuditConfigEdit[] {
  const nameLc = opts.name.toLowerCase();
  const userPath = userConfigPath(opts.chain, opts.userConfigPath);

  if (opts.enabled) {
    const addUrl = opts.url?.trim()
      || uniqueAuditSourcesWithSuppressed(opts.chain).find((s) => s.name.toLowerCase() === nameLc)?.url
      || '';
    if (!addUrl) return [];

    const clearer = opts.chain.find((f) => f.auditSourcesCleared);
    if (clearer && !isMachineFile(clearer)) {
      return [{ op: 'upsert', filePath: clearer.filePath, name: opts.name, url: addUrl }];
    }
    const declared = opts.chain.find((f) => !isMachineFile(f) && hasAuditKey(f, nameLc));
    if (declared) {
      return [{ op: 'upsert', filePath: declared.filePath, name: opts.name, url: addUrl }];
    }
    return [{ op: 'upsert', filePath: userPath, name: opts.name, url: addUrl }];
  }

  const removes: AuditConfigEdit[] = [];
  for (const file of opts.chain) {
    if (isMachineFile(file) || !hasAuditKey(file, nameLc)) continue;
    removes.push({ op: 'remove', filePath: file.filePath, name: opts.name });
  }

  const simulated = stripAuditKey(opts.chain, nameLc, isMachineFile);
  const stillDeclared = uniqueDeclaredAuditSources(simulated).some((s) => s.name.toLowerCase() === nameLc);
  if (!stillDeclared) return removes;

  const keep = uniqueDeclaredAuditSources(simulated)
    .filter((s) => s.name.toLowerCase() !== nameLc)
    .filter((s) => {
      const origin = simulated.find((f) => pathsEqual(f.filePath, s.configFilePath))
        ?? opts.chain.find((f) => pathsEqual(f.filePath, s.configFilePath));
      if (!origin) return pathsEqual(s.configFilePath, userPath);
      return isMachineFile(origin)
        || pathsEqual(origin.filePath, userPath)
        || isGlobalNuGetConfigPath(origin.filePath);
    })
    .map((s) => ({ name: s.name, url: s.url }));

  return [
    ...removes.filter((e) => !pathsEqual(e.filePath, userPath)),
    { op: 'replace', filePath: userPath, sources: keep, clear: true },
  ];
}
