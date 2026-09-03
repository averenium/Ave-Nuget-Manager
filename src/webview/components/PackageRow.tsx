import React from 'react';
import { compareSemVer } from '../utils/search';
import type { InstalledPackage, ImplicitPackage, AvailablePackage, VulnerabilityFinding, PackageSourceMapping } from '../../types';
import { findingsAffectingPackage } from '../../vulnerabilities';
import { packageMatchesAnyMapping } from '../../packageSourceMapping';
import { PkgListRow } from './PkgListRow';

/** Extract project name from absolute path without using Node's path module */
function projectName(absolutePath: string): string {
  const withoutExt = absolutePath.replace(/\.[^.]+$/, '');
  return withoutExt.split(/[\\/]/).pop() ?? absolutePath;
}

interface Props {
  pkg: InstalledPackage | ImplicitPackage | AvailablePackage;
  kind: 'installed' | 'implicit' | 'available';
  selected?: boolean;
  implicitVersions?: string[];
  /** All project entries for this package id — used to show version conflicts */
  allProjectEntries?: Array<{ projectPath: string; resolvedVersion: string }>;
  findings?: VulnerabilityFinding[];
  blocked?: boolean;
  /** Active `<packageSourceMapping>` — installed rows only; see #40 follow-up. */
  packageSourceMapping?: PackageSourceMapping[];
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const MAX_VERSIONS_INLINE = 3;

function formatFindingLine(finding: VulnerabilityFinding, viaPackage?: string): string {
  const sev = finding.severity.toUpperCase();
  const label = finding.id ?? finding.title ?? finding.url ?? 'advisory';
  return viaPackage ? `via ${viaPackage} · ${sev}: ${label}` : `${sev}: ${label}`;
}

export function PackageRow({
  pkg, kind, selected, implicitVersions, allProjectEntries, findings, blocked, packageSourceMapping, onClick, onContextMenu,
}: Props) {
  const installed = kind === 'installed' ? (pkg as InstalledPackage) : undefined;
  const implicit  = kind === 'implicit'  ? (pkg as ImplicitPackage)  : undefined;
  const available = kind === 'available' ? (pkg as AvailablePackage) : undefined;

  const sourceName = (installed?.sourceName ?? available?.sourceName ?? '').toLowerCase();
  const latestVersion = installed?.latestVersion ?? available?.latestVersion;
  const hasUpdate = !!(installed && latestVersion &&
    compareSemVer(latestVersion, installed.resolvedVersion) > 0);
  const latestDisplay = latestVersion ?? (kind === 'installed' ? '…' : '—');

  const highestImplicit = implicitVersions?.length
    ? implicitVersions.reduce((max, v) => (v > max ? v : max))
    : undefined;

  // ── Multi-version display (solution scope) ─────────────────────────────────
  // Collect unique versions across projects
  const projectVersionMap: Array<{ projectName: string; version: string }> = [];
  if (allProjectEntries && allProjectEntries.length > 1) {
    for (const entry of allProjectEntries) {
      const pName = projectName(entry.projectPath);
      projectVersionMap.push({ projectName: pName, version: entry.resolvedVersion });
    }
  }

  const uniqueVersions = [...new Set(projectVersionMap.map((e) => e.version))];
  const hasMultipleVersions = uniqueVersions.length > 1;
  // Version label: single version OR "v1 / v2 / v3 ..."
  let versionLabel: string;
  if (hasMultipleVersions) {
    const shown = uniqueVersions.slice(0, MAX_VERSIONS_INLINE);
    versionLabel = shown.join(' / ') + (uniqueVersions.length > MAX_VERSIONS_INLINE ? ' …' : '');
  } else {
    versionLabel =
      installed?.resolvedVersion ??
      implicit?.resolvedVersion ??
      available?.latestVersion ??
      '';
  }

  // Hover tooltip: "ProjectA: 1.0.0\nProjectB: 2.0.0"
  const versionTooltip = projectVersionMap.length > 1
    ? projectVersionMap.map((e) => `${e.projectName}: ${e.version}`).join('\n')
    : undefined;

  const deps = installed?.dependencies ?? implicit?.dependencies;
  // Only pin findings to this row's own version when it unambiguously has one —
  // a multi-version aggregate row (this id at different versions across
  // projects) still shows a finding for any of those versions (#53).
  const rowVersion = hasMultipleVersions ? undefined : versionLabel;
  const { direct, via } = kind === 'available'
    ? { direct: [] as VulnerabilityFinding[], via: [] as VulnerabilityFinding[] }
    : findingsAffectingPackage(findings ?? [], pkg.id, deps, rowVersion || undefined);
  const vulnTitle = [...direct.map((f) => formatFindingLine(f)), ...via.map((f) => formatFindingLine(f, f.packageId))]
    .join('\n') || undefined;

  const mappingActive = kind === 'installed' && !!packageSourceMapping?.length;
  const hasNoMappingSource = mappingActive && !packageMatchesAnyMapping(pkg.id, packageSourceMapping!);
  const unmappedTitle = hasNoMappingSource
    ? `No packageSourceMapping source matches "${pkg.id}" — restore will not be able to find it.\nMapped sources: ${
      packageSourceMapping!.map((m) => m.sourceName).join(', ')
    }`
    : undefined;

  return (
    <PkgListRow
      name={pkg.id}
      selected={selected}
      hasUpdate={hasUpdate}
      hasNoMappingSource={hasNoMappingSource}
      unmappedTitle={unmappedTitle}
      blocked={!!blocked}
      hasVulnerability={direct.length + via.length > 0}
      vulnerabilityVia={direct.length === 0 && via.length > 0}
      vulnerabilityTitle={vulnTitle}
      onActivate={onClick}
      onContextMenu={onContextMenu}
      aside={sourceName ? (
        <span className="pkg-row__source" title={sourceName}>{sourceName}</span>
      ) : null}
    >
      <div className="pkg-row__meta">
        <span
          className={hasMultipleVersions ? 'pkg-row__version pkg-row__version--multi' : 'pkg-row__version'}
          title={versionTooltip}
        >
          {kind !== 'available' ? versionLabel : ''}
          {highestImplicit && (
            <span className="pkg-row__implicit" title={implicitVersions?.join(', ')}>
              ({highestImplicit})
            </span>
          )}
        </span>
        <span
          className={`pkg-row__latest${hasUpdate ? ' pkg-row__latest--update' : ''}`}
          title={latestVersion ? `Available: ${latestVersion}` : undefined}
        >
          {kind === 'implicit' && !latestVersion ? '' : latestDisplay}
        </span>
      </div>
    </PkgListRow>
  );
}
