import { packageMatchesAnyMapping } from '../../packageSourceMapping';
import type { PackageSourceMapping, VulnerabilityFinding, VulnerabilitySeverity } from '../../types';
import type { LicenseChange } from '../../packageLicense';

export type ProblemTone = 'error' | 'warning';

/**
 * Data shape for one "Problems" entry in the package detail panel — the
 * component turns this into JSX, kept separate here so the actual decision
 * logic (which problems appear, with what tone) is testable without
 * rendering (#57).
 */
export type ProblemDescriptor =
  | { kind: 'vulnerability'; key: string; tone: ProblemTone; label: string; via?: string; finding: VulnerabilityFinding }
  | { kind: 'mapping'; key: 'mapping'; tone: ProblemTone; label: string; mappedSourceNames: string[] }
  | { kind: 'blocked'; key: 'blocked'; tone: ProblemTone; label: string }
  | { kind: 'deprecation'; key: 'deprecation'; tone: ProblemTone; label: string; message: string }
  | { kind: 'unlisted'; key: 'unlisted'; tone: ProblemTone; label: string; version: string }
  | {
      kind: 'feed-advisory';
      key: string;
      tone: ProblemTone;
      label: string;
      version: string;
      url?: string;
    }
  | {
      kind: 'licence';
      key: 'licence';
      tone: ProblemTone;
      label: string;
      change: LicenseChange;
    };

function vulnerabilityProblems(
  findings: VulnerabilityFinding[],
  viaFindings: VulnerabilityFinding[],
): ProblemDescriptor[] {
  return findings.map((finding, index) => {
    const via = viaFindings.includes(finding) ? finding.packageId : undefined;
    const tone: ProblemTone = finding.severity === 'moderate' || finding.severity === 'low' ? 'warning' : 'error';
    return {
      kind: 'vulnerability',
      key: `vuln:${via ?? 'direct'}:${finding.source}:${finding.id ?? finding.url ?? index}`,
      tone,
      label: finding.severity,
      via,
      finding,
    };
  });
}

export function buildPackageProblems(opts: {
  packageId: string;
  findings: VulnerabilityFinding[];
  viaFindings: VulnerabilityFinding[];
  isInstalled: boolean;
  packageSourceMapping: PackageSourceMapping[];
  updatesBlocked: boolean;
  /** Feed deprecation notice for the version currently shown in the Info panel (#86) — never from a nuspec. */
  deprecation?: string;
  /**
   * Set when the installed version has been withdrawn from its feed (#114).
   * Deliberately not asked about whatever version is picked in the dropdown —
   * withdrawal only matters for the version a project is actually on, not one
   * being browsed for an update.
   */
  unlistedInstalledVersion?: string;
  /** Set when the selected version's licence differs from the installed one (#89). */
  licenseChange?: LicenseChange;
  /**
   * What the feed says about the version currently selected, and the version it
   * says it about (#27).
   *
   * Deliberately separate from `findings`, which come from the restore-graph
   * scan and describe what is **installed**. Both belong here, but they are
   * different statements: one says a problem is already present, the other that
   * taking this version would introduce one. Merging them would tell a user
   * browsing versions that they already have a vulnerability they do not.
   */
  selectedVersion?: string;
  selectedVersionAdvisories?: Array<{ url?: string; severity: VulnerabilitySeverity }>;
}): ProblemDescriptor[] {
  const {
    packageId, findings, viaFindings, isInstalled, packageSourceMapping, updatesBlocked,
    deprecation, unlistedInstalledVersion, licenseChange, selectedVersion, selectedVersionAdvisories,
  } = opts;

  const problems: ProblemDescriptor[] = [...vulnerabilityProblems(findings, viaFindings)];

  if (deprecation) {
    problems.push({ kind: 'deprecation', key: 'deprecation', tone: 'warning', label: 'deprecated', message: deprecation });
  }

  if (unlistedInstalledVersion) {
    // Amber, not red: nothing has failed yet. It still restores from whatever
    // already cached it — withdrawal only risks a machine that never has.
    problems.push({
      kind: 'unlisted', key: 'unlisted', tone: 'warning', label: 'unlisted', version: unlistedInstalledVersion,
    });
  }

  // An advisory the scan already reported is not repeated: the scan speaks for
  // what is installed and names it more fully. Anything the scan did not
  // mention is shown, including at the installed version — the scan and the
  // feed do not always cover the same advisories, and silence there would hide
  // a real one rather than avoid a duplicate.
  const alreadyReported = new Set(
    findings.map((f) => f.url).filter((u): u is string => !!u),
  );
  if (selectedVersion && selectedVersionAdvisories?.length) {
    for (const [index, advisory] of selectedVersionAdvisories.entries()) {
      if (advisory.url && alreadyReported.has(advisory.url)) continue;
      problems.push({
        kind: 'feed-advisory',
        key: `feed-advisory:${advisory.url ?? index}`,
        tone: advisory.severity === 'low' || advisory.severity === 'moderate' ? 'warning' : 'error',
        label: advisory.severity,
        version: selectedVersion,
        url: advisory.url,
      });
    }
  }

  if (licenseChange) {
    // A licence the tool cannot name is the stronger case: the user has to open
    // the file to learn what they would be agreeing to.
    problems.push({
      kind: 'licence',
      key: 'licence',
      tone: licenseChange.unnamed ? 'error' : 'warning',
      label: 'licence changes',
      change: licenseChange,
    });
  }

  const mappingActive = isInstalled && packageSourceMapping.length > 0;
  if (mappingActive && !packageMatchesAnyMapping(packageId, packageSourceMapping)) {
    problems.push({
      kind: 'mapping',
      key: 'mapping',
      tone: 'error',
      label: 'unmapped',
      mappedSourceNames: packageSourceMapping.map((m) => m.sourceName),
    });
  }

  if (updatesBlocked) {
    problems.push({ kind: 'blocked', key: 'blocked', tone: 'warning', label: 'blocked' });
  }

  return problems;
}
