import { packageMatchesAnyMapping } from '../../packageSourceMapping';
import type { PackageSourceMapping, VulnerabilityFinding } from '../../types';

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
  | { kind: 'deprecation'; key: 'deprecation'; tone: ProblemTone; label: string; message: string };

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
}): ProblemDescriptor[] {
  const { packageId, findings, viaFindings, isInstalled, packageSourceMapping, updatesBlocked, deprecation } = opts;

  const problems: ProblemDescriptor[] = [...vulnerabilityProblems(findings, viaFindings)];

  if (deprecation) {
    problems.push({ kind: 'deprecation', key: 'deprecation', tone: 'warning', label: 'deprecated', message: deprecation });
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
