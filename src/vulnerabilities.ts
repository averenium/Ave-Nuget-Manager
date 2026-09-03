import { extractJsonObject } from './dotnetOutput';
import type { VulnerabilityFinding, VulnerabilitySeverity } from './types';

const SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export function severityRank(severity: VulnerabilitySeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

export function normalizeSeverity(raw: string | undefined): VulnerabilitySeverity {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'moderate':
    case 'medium': return 'moderate';
    case 'low': return 'low';
    default: return 'unknown';
  }
}

function findingKey(finding: VulnerabilityFinding): string {
  return [
    finding.packageId.toLowerCase(),
    (finding.version ?? '').toLowerCase(),
    (finding.id ?? finding.url ?? finding.title ?? '').toLowerCase(),
  ].join('\0');
}

/** Deduplicate by package + version + advisory id/url. Highest severity wins. */
export function mergeFindings(batches: VulnerabilityFinding[][]): VulnerabilityFinding[] {
  const byKey = new Map<string, VulnerabilityFinding>();
  for (const finding of batches.flat()) {
    if (!finding.packageId) continue;
    const key = findingKey(finding);
    const prev = byKey.get(key);
    if (!prev || severityRank(finding.severity) > severityRank(prev.severity)) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const rank = severityRank(b.severity) - severityRank(a.severity);
    if (rank !== 0) return rank;
    return a.packageId.localeCompare(b.packageId);
  });
}

/**
 * Findings for one package id. `version`, when given, additionally requires
 * the finding's own version to match — a solution can have the same id at
 * different versions across projects (e.g. one project transitively pulling
 * an old, vulnerable version while another has it upgraded directly), and
 * without this a row for the *patched* version would still show the *other*
 * project's finding, id-matched but for a version this row does not have (#53).
 * A finding with no version (e.g. a user script that did not report one)
 * still matches, to not silently drop it.
 */
export function findingsForPackage(
  findings: VulnerabilityFinding[],
  packageId: string,
  version?: string,
): VulnerabilityFinding[] {
  const key = packageId.toLowerCase();
  return findings.filter((f) => {
    if (f.packageId.toLowerCase() !== key) return false;
    if (version === undefined || f.version === undefined) return true;
    return f.version === version;
  });
}

/** Findings on restore-graph dependencies (implicit or other installed), not on this id. */
export function findingsViaDependencies(
  findings: VulnerabilityFinding[],
  packageId: string,
  dependencies: readonly string[] | undefined,
): VulnerabilityFinding[] {
  if (!dependencies || dependencies.length === 0) return [];
  const self = packageId.toLowerCase();
  const depSet = new Set(dependencies.map((id) => id.toLowerCase()));
  return findings.filter((f) => {
    const id = f.packageId.toLowerCase();
    return id !== self && depSet.has(id);
  });
}

export function findingsAffectingPackage(
  findings: VulnerabilityFinding[],
  packageId: string,
  dependencies?: readonly string[],
  version?: string,
): { direct: VulnerabilityFinding[]; via: VulnerabilityFinding[] } {
  return {
    direct: findingsForPackage(findings, packageId, version),
    via: findingsViaDependencies(findings, packageId, dependencies),
  };
}

/** Direct hits rank above transitive; within each group, higher severity first. */
export function vulnerabilityAffectRank(
  findings: VulnerabilityFinding[],
  packageId: string,
  dependencies?: readonly string[],
  version?: string,
): number {
  const { direct, via } = findingsAffectingPackage(findings, packageId, dependencies, version);
  if (direct.length > 0) {
    return 1000 + Math.max(...direct.map((f) => severityRank(f.severity)));
  }
  if (via.length > 0) {
    return Math.max(...via.map((f) => severityRank(f.severity)));
  }
  return -1;
}

export function maxSeverityForPackage(
  findings: VulnerabilityFinding[],
  packageId: string,
): VulnerabilitySeverity | undefined {
  const list = findingsForPackage(findings, packageId);
  if (list.length === 0) return undefined;
  return list.reduce((best, f) =>
    severityRank(f.severity) > severityRank(best) ? f.severity : best,
  list[0].severity);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize one finding from a user script (or any JSON object).
 * Unknown fields are ignored; `source` is filled if missing.
 */
export function normalizeFinding(raw: unknown, fallbackSource: string): VulnerabilityFinding | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const packageId = str(rec.packageId);
  if (!packageId) return null;
  return {
    packageId,
    version: str(rec.version) ?? str(rec.resolvedVersion),
    severity: normalizeSeverity(str(rec.severity)),
    id: str(rec.advisoryId) ?? str(rec.id),
    title: str(rec.title),
    url: str(rec.url) ?? str(rec.advisoryUrl) ?? str(rec.advisoryurl),
    source: str(rec.source) ?? fallbackSource,
  };
}

export function parseScriptFindings(stdout: string, source: string): VulnerabilityFinding[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const jsonText = (() => {
    const arrStart = trimmed.indexOf('[');
    const objStart = trimmed.indexOf('{');
    if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
      const arrEnd = trimmed.lastIndexOf(']');
      if (arrEnd > arrStart) return trimmed.slice(arrStart, arrEnd + 1);
    }
    return extractJsonObject(trimmed) ?? trimmed;
  })();
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(asRecord(parsed)?.findings)
        ? (asRecord(parsed)!.findings as unknown[])
        : [];
    return list
      .map((item) => normalizeFinding(item, source))
      .filter((f): f is VulnerabilityFinding => f !== null);
  } catch {
    return [];
  }
}

interface DotnetVulnerablePackage {
  id?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  vulnerabilities?: Array<{
    severity?: string;
    advisoryurl?: string;
    advisoryUrl?: string;
  }>;
}

/**
 * `dotnet list package --vulnerable --format json`.
 * Walks top-level and transitive packages across projects/frameworks.
 */
export function parseDotnetVulnerableJson(stdout: string): VulnerabilityFinding[] {
  const raw = extractJsonObject(stdout);
  if (!raw) return [];
  let parsed: {
    projects?: Array<{
      frameworks?: Array<{
        topLevelPackages?: DotnetVulnerablePackage[];
        transitivePackages?: DotnetVulnerablePackage[];
      }>;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const findings: VulnerabilityFinding[] = [];
  for (const project of parsed.projects ?? []) {
    for (const fw of project.frameworks ?? []) {
      const packages = [
        ...(fw.topLevelPackages ?? []),
        ...(fw.transitivePackages ?? []),
      ];
      for (const pkg of packages) {
        if (!pkg.id || !pkg.vulnerabilities?.length) continue;
        for (const vuln of pkg.vulnerabilities) {
          const url = vuln.advisoryUrl ?? vuln.advisoryurl;
          findings.push({
            packageId: pkg.id,
            version: pkg.resolvedVersion,
            severity: normalizeSeverity(vuln.severity),
            id: advisoryIdFromUrl(url),
            url,
            source: 'dotnet',
          });
        }
      }
    }
  }
  return mergeFindings([findings]);
}

export function advisoryIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ghsa = url.match(/GHSA-[0-9a-z-]+/i);
  if (ghsa) return ghsa[0];
  const cve = url.match(/CVE-\d{4}-\d+/i);
  return cve?.[0];
}
