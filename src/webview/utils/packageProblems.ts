import { packageMatchesAnyMapping } from '../../packageSourceMapping';
import { versionsEqual } from '../../semver';
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
    }
  | {
      /**
       * The selected version clears a direct, installed vulnerability (#122)
       * — the one positive statement this band can make, and the most useful
       * one when it applies: it is why the reader picked this version in the
       * first place. Carries no tone/label: it is not a problem, so it never
       * renders through the same `<li>` the others share.
       */
      kind: 'resolved';
      key: 'resolved';
      version: string;
      /** How many direct findings it clears — for "vulnerability" vs "vulnerabilities". */
      count: number;
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

  // The most useful sentence this band can produce (#122): the reader most
  // likely picked this version to get away from an installed vulnerability,
  // and nothing else here says whether it worked. Only a *direct* finding
  // counts — a transitive one lives on a different package, and changing
  // this one's version does nothing to it. Silent whenever a finding's own
  // version is unknown (nothing to compare) or the feed still flags the
  // picked version itself: that is a sharper warning of its own, not a
  // resolution — checked against the feed's raw answer, before the
  // already-reported ones above are filtered out, since a repeat is still a
  // reason this version is not clear.
  const directFindings = findings.filter((f) => !viaFindings.includes(f));
  if (
    selectedVersion
    && directFindings.length > 0
    && !directFindings.some((f) => f.version === undefined || versionsEqual(f.version, selectedVersion))
    && !selectedVersionAdvisories?.length
  ) {
    problems.push({ kind: 'resolved', key: 'resolved', version: selectedVersion, count: directFindings.length });
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

export type ProblemGroup = 'installed' | 'selected' | 'general';

/**
 * Which subject a problem is about (#122): the version actually on disk, the
 * version the dropdown currently holds, or the package as a whole regardless
 * of version. Rendering every kind the same way is what let an advisory
 * about the installed version read as one about whatever the reader had
 * since picked — the fix is a heading naming the subject, and this is the
 * decision behind it, kept separate from the JSX so it stays testable.
 *
 * `licence`, `deprecation` and `resolved` go with `selected`: a licence
 * problem is what *taking* the picked version would change, deprecation
 * follows whatever version the Info section is currently showing (which
 * tracks the selection), and `resolved` is a statement about the picked
 * version by definition. `mapping` and `blocked` are package-wide facts with
 * no version of their own, so neither heading fits them.
 *
 * Written as an exhaustive switch rather than a `default` bucket on purpose:
 * a `default: return 'general'` would let a kind added to the union later
 * compile untouched and land in the wrong group silently, which is the exact
 * mistake this function exists to stop making. `never` below is what turns
 * that into a build error instead.
 */
export function problemGroup(kind: ProblemDescriptor['kind']): ProblemGroup {
  switch (kind) {
    case 'vulnerability':
    case 'unlisted':
      return 'installed';
    case 'feed-advisory':
    case 'licence':
    case 'deprecation':
    case 'resolved':
      return 'selected';
    case 'mapping':
    case 'blocked':
      return 'general';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
