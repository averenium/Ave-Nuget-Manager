/**
 * NuGet version-range parsing and dependency-row classification for the
 * Dependencies section (#86 design pass). A `<dependency version="...">` /
 * `project.assets.json` `dependencies` value is a *range*, not a version:
 * `6.8.1` means "6.8.1 or newer" (a floor with no ceiling), while
 * `[2.7.5, 3.0.0)` is a real interval. Rendering the two the same way would
 * flag every ordinary bump as if it were a hard constraint.
 */

import { compareSemVer } from './semver';

export interface NuGetVersionRange {
  minVersion?: string;
  minInclusive: boolean;
  maxVersion?: string;
  maxInclusive: boolean;
  /** `[1.0.0]` — min and max are the same, both inclusive. */
  isExact: boolean;
}

/** Parses NuGet's version-range grammar: a bare version (floor only) or a bracket/paren interval. */
export function parseNuGetVersionRange(range: string): NuGetVersionRange {
  const trimmed = range.trim();
  const m = /^([[(])\s*([^,[\]()]*)\s*(?:,\s*([^,[\]()]*)\s*)?([)\]])$/.exec(trimmed);
  if (!m) {
    // Bare version: minimum inclusive, no ceiling.
    return { minVersion: trimmed || undefined, minInclusive: true, maxInclusive: true, isExact: false };
  }
  const [, open, first, second, close] = m;
  const minInclusive = open === '[';
  const maxInclusive = close === ']';
  if (second === undefined) {
    // `[1.0.0]` — exact pin.
    const v = first || undefined;
    return { minVersion: v, minInclusive: true, maxVersion: v, maxInclusive: true, isExact: true };
  }
  return {
    minVersion: first || undefined,
    minInclusive,
    maxVersion: second || undefined,
    maxInclusive,
    isExact: false,
  };
}

export function rangeHasCeiling(range: NuGetVersionRange): boolean {
  return range.maxVersion !== undefined;
}

export function versionSatisfiesRange(version: string, range: NuGetVersionRange): boolean {
  if (range.minVersion) {
    const cmp = compareSemVer(version, range.minVersion);
    if (range.minInclusive ? cmp < 0 : cmp <= 0) return false;
  }
  if (range.maxVersion) {
    const cmp = compareSemVer(version, range.maxVersion);
    if (range.maxInclusive ? cmp > 0 : cmp >= 0) return false;
  }
  return true;
}

function majorOf(version: string): number {
  return parseInt(version.split(/[.-]/, 1)[0] ?? '0', 10) || 0;
}

/** Renders a NuGet range back to its bracket notation, for display next to a flagged dependency. */
export function formatNuGetVersionRange(range: NuGetVersionRange): string {
  if (range.isExact) return `[${range.minVersion}]`;
  const open = range.minInclusive ? '[' : '(';
  const close = range.maxInclusive ? ']' : ')';
  return `${open}${range.minVersion ?? ''}, ${range.maxVersion ?? ''}${close}`;
}

export type DependencyRowStatus = 'ok' | 'outside-range' | 'major-lifted';

export interface DependencyRowClassification {
  status: DependencyRowStatus;
  /** Whether to display the declared range text next to the row (ceilings always do; a bare floor only when it's the reason for the "major-lifted" hint). */
  showDeclared: boolean;
}

/**
 * Classifies one dependency row against NuGet's own resolution semantics:
 * - A range with a ceiling is a real constraint and always worth showing;
 *   a resolved version outside it is `outside-range` (NuGet reports this on
 *   restore as NU1608, on a build that still succeeds).
 * - A bare floor (no ceiling) is only a minimum the author asserted forward
 *   compatibility for. Equal to, or a minor/patch bump above, that floor is
 *   unremarkable (`ok`); a different major is `major-lifted` — worth a
 *   glance, not a claim of breakage.
 */
export function classifyDependencyRow(declaredRange: string, resolvedVersion: string): DependencyRowClassification {
  const range = parseNuGetVersionRange(declaredRange);

  if (range.isExact) {
    const satisfied = !!range.minVersion && compareSemVer(resolvedVersion, range.minVersion) === 0;
    return { status: satisfied ? 'ok' : 'outside-range', showDeclared: !satisfied };
  }

  if (rangeHasCeiling(range)) {
    const satisfied = versionSatisfiesRange(resolvedVersion, range);
    return { status: satisfied ? 'ok' : 'outside-range', showDeclared: true };
  }

  if (!range.minVersion) return { status: 'ok', showDeclared: false };
  if (compareSemVer(resolvedVersion, range.minVersion) === 0) return { status: 'ok', showDeclared: false };
  const lifted = majorOf(resolvedVersion) !== majorOf(range.minVersion);
  return { status: lifted ? 'major-lifted' : 'ok', showDeclared: lifted };
}
