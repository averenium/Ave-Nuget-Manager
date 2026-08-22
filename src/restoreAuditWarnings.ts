import type { VulnerabilityFinding, VulnerabilitySeverity } from './types';
import { advisoryIdFromUrl, mergeFindings, normalizeSeverity } from './vulnerabilities';

const NU190: Record<string, VulnerabilitySeverity> = {
  NU1901: 'low',
  NU1902: 'moderate',
  NU1903: 'high',
  NU1904: 'critical',
};

export interface RestoreAuditScope {
  installed: Array<{ id: string; resolvedVersion: string }>;
  implicit: Array<{ id: string; resolvedVersion: string }>;
}

/**
 * `warning NU1902: Package 'SharpCompress' 0.30.1 has a known moderate severity vulnerability, https://…`
 * Fallback when the HTTP-cache VDB files are hashed/unreadable. Direct-only if NuGetAuditMode is default.
 * When `scope` is set, only ids+versions in the current installed/implicit list are kept.
 */
export function parseRestoreAuditWarnings(text: string, scope?: RestoreAuditScope): VulnerabilityFinding[] {
  if (!text) return [];
  const findings: VulnerabilityFinding[] = [];
  const re = /NU190[1-4]:\s*Package '([^']+)'\s+(\S+)\s+has a known (\w+) severity vulnerability,\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = text.slice(m.index, m.index + 6).toUpperCase();
    const url = m[4].replace(/[.)]+$/, '');
    findings.push({
      packageId: m[1],
      version: m[2],
      severity: NU190[code] ?? normalizeSeverity(m[3]),
      id: advisoryIdFromUrl(url),
      url,
      source: 'dotnet',
    });
  }
  const merged = mergeFindings([findings]);
  if (!scope) return merged;
  const known = new Set(
    [...scope.installed, ...scope.implicit].map((p) => `${p.id.toLowerCase()}\0${p.resolvedVersion}`),
  );
  return merged.filter((f) => known.has(`${f.packageId.toLowerCase()}\0${f.version}`));
}
