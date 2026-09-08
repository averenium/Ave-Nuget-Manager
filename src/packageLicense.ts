/**
 * License display resolution for the Info panel's attribute column (#86
 * design pass, "Licences"). `<license type="expression">` is an SPDX
 * string — sometimes compound (`MIT AND Apache-2.0`) — `type="file"` names
 * a file bundled in the package with nothing to link to, and a bare
 * `licenseUrl` (no `<license>` element at all) is the last resort, except
 * for NuGet's own deprecated-field placeholder, which links to a page
 * explaining that the field is deprecated rather than to any actual license.
 */

import type { PackageLicense } from './types';

export type LicenseDisplay =
  | { kind: 'expression'; ids: string[]; operators: Array<'AND' | 'OR'>; fullExpression: string }
  | { kind: 'file'; fileName: string }
  | { kind: 'url'; url: string }
  | { kind: 'none' };

/** Splits a (possibly compound) SPDX expression into its identifiers and the `AND`/`OR` operators between them — legally meaningful (`AND` = both apply, `OR` = choose), so kept rather than flattened into one string. */
export function splitSpdxExpression(expression: string): { ids: string[]; operators: Array<'AND' | 'OR'> } {
  const stripped = expression.trim().replace(/^\((.*)\)$/, '$1').trim();
  const tokens = stripped.split(/\s+(AND|OR)\s+/i);
  const ids: string[] = [];
  const operators: Array<'AND' | 'OR'> = [];
  tokens.forEach((tok, i) => {
    if (i % 2 === 1) operators.push(tok.toUpperCase() as 'AND' | 'OR');
    else if (tok.trim()) ids.push(tok.trim());
  });
  return { ids, operators };
}

export function spdxBadgeUrl(spdxId: string): string {
  return `https://licenses.nuget.org/${encodeURIComponent(spdxId)}`;
}

/** NuGet's own placeholder for "a real `<license>` element is present, this field is deprecated" — filtered by exact value, not by domain, so a genuine aka.ms-hosted license page (if one ever existed) wouldn't be swept up with it. */
function isDeprecatedLicenseUrlPlaceholder(url: string): boolean {
  try {
    const u = new URL(url);
    return u.host.toLowerCase() === 'aka.ms' && u.pathname.toLowerCase() === '/deprecatelicenseurl';
  } catch {
    return false;
  }
}

export function resolveLicenseDisplay(
  license: PackageLicense | undefined,
  licenseUrl: string | undefined,
): LicenseDisplay {
  if (license?.type === 'expression') {
    const { ids, operators } = splitSpdxExpression(license.value);
    return { kind: 'expression', ids, operators, fullExpression: license.value };
  }
  if (license?.type === 'file') {
    return { kind: 'file', fileName: license.value };
  }
  if (licenseUrl && !isDeprecatedLicenseUrlPlaceholder(licenseUrl)) {
    return { kind: 'url', url: licenseUrl };
  }
  return { kind: 'none' };
}
