import React from 'react';
import { compareSemVer } from '../utils/search';
import type { InstalledPackage, ImplicitPackage, AvailablePackage, VulnerabilityFinding, PackageSourceMapping, VersionFlag } from '../../types';
import { findingsAffectingPackage } from '../../vulnerabilities';
import { packageMatchesAnyMapping } from '../../packageSourceMapping';
import { resolveVersionSpread } from '../../packageResolvedVersions';
import { versionCellFor, versionSpreadTooltip } from '../utils/versionSpreadDisplay';
import { PkgListRow } from './PkgListRow';

interface Props {
  pkg: InstalledPackage | ImplicitPackage | AvailablePackage;
  kind: 'installed' | 'implicit' | 'available';
  selected?: boolean;
  implicitVersions?: string[];
  /** All project entries for this package id — used to show version conflicts */
  allProjectEntries?: Array<{ projectPath: string; resolvedVersion: string; framework?: string }>;
  findings?: VulnerabilityFinding[];
  blocked?: boolean;
  /** Active `<packageSourceMapping>` — installed rows only; see #40 follow-up. */
  packageSourceMapping?: PackageSourceMapping[];
  /**
   * What the feed says about the versions of this package, keyed by version.
   * Only the deprecation of the version this row actually shows is used: a
   * newer version being deprecated says nothing about the one installed.
   */
  versionFlags?: Record<string, VersionFlag>;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function formatFindingLine(finding: VulnerabilityFinding, viaPackage?: string): string {
  const sev = finding.severity.toUpperCase();
  const label = finding.id ?? finding.title ?? finding.url ?? 'advisory';
  return viaPackage ? `via ${viaPackage} · ${sev}: ${label}` : `${sev}: ${label}`;
}

export function PackageRow({
  pkg, kind, selected, implicitVersions, allProjectEntries, findings, blocked, packageSourceMapping, versionFlags, onClick, onContextMenu,
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

  // ── Several resolved versions in one row (#90, #115) ────────────────────────
  // `allProjectEntries` is homogeneous per caller — every direct entry for an
  // installed row, every transitive one for an implicit row — so it slots
  // straight into whichever side `resolveVersionSpread` expects. Which version
  // is primary, and whether the spread is between projects or between one
  // project's frameworks, comes from there rather than from a rule of this
  // row's own, so the list and the details panel can never describe the same
  // package differently.
  const directEntries = kind === 'installed' ? (allProjectEntries ?? []) : [];
  const transitiveEntries = kind === 'implicit' ? (allProjectEntries ?? []) : [];
  const spread = allProjectEntries?.length
    ? resolveVersionSpread(directEntries, transitiveEntries)
    : undefined;
  const hasMultipleVersions = !!spread && spread.others.length > 0;
  const cell = hasMultipleVersions ? versionCellFor(spread!, allProjectEntries!) : undefined;
  const versionTooltip = hasMultipleVersions
    ? versionSpreadTooltip(allProjectEntries!, spread!.withinOneProject)
    : undefined;

  const versionLabel = hasMultipleVersions
    ? cell!.primary
    : (installed?.resolvedVersion ?? implicit?.resolvedVersion ?? available?.latestVersion ?? '');

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

  // Deprecation belongs to one version, so an aggregate row showing several
  // has no single answer and is left unmarked — the same rule `rowVersion`
  // already applies to findings.
  const deprecation = rowVersion ? versionFlags?.[rowVersion]?.deprecation : undefined;
  const deprecationTitle = deprecation ? `Deprecated: ${deprecation}` : undefined;

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
      deprecationTitle={deprecationTitle}
      onActivate={onClick}
      onContextMenu={onContextMenu}
      aside={sourceName ? (
        <span className="pkg-row__source" title={sourceName}>{sourceName}</span>
      ) : null}
    >
      <div className="pkg-row__meta">
        <span className="pkg-row__version" title={versionTooltip}>
          {kind === 'available' ? '' : hasMultipleVersions ? (
            <>
              <span className="pkg-row__version-primary">{cell!.primary}</span>
              {cell!.rest.map((v) => (
                <React.Fragment key={v}>
                  <span className="pkg-row__version-sep"> · </span>
                  {v}
                </React.Fragment>
              ))}
              {cell!.moreCount > 0 ? (
                <>
                  {' '}
                  <span className={cell!.crossesMajor ? 'pkg-row__more pkg-row__more--major' : 'pkg-row__more'}>
                    {`+${cell!.moreCount}`}
                  </span>
                </>
              ) : cell!.axis ? (
                <>
                  {' '}
                  <span className="pkg-row__axis">{cell!.axis}</span>
                </>
              ) : null}
            </>
          ) : versionLabel}
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
