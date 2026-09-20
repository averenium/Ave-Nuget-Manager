/**
 * How a package's resolved-version spread is drawn in the package list — the
 * compact cell beside the name, and the tooltip behind it (#115).
 *
 * `resolveVersionSpread` already decides which version is primary and
 * whether the spread is between projects or between one project's
 * frameworks; this module only turns that decision into the two pieces of
 * text the row shows, so the list and the details panel can never describe
 * the same package differently.
 */

import type { ResolvedVersionSpread } from '../../packageResolvedVersions';
import { sameMajorLine } from '../../frameworkPins';
import { compareSemVer } from '../../semver';
import { normalizeFsPath } from '../../pathCompare';
import { fileNameNoExt } from './pathUtils';

/**
 * How many versions the cell prints before folding the rest into a count —
 * the primary plus one stepped-back version, matching the settled colour
 * mockup's own rows (`3.1.0 · 3.0.4 +1`, `9.0.0 · 6.0.0 +2`); the cell
 * mockup's own unmarked variant D went one further, but that document never
 * says which of its variants was chosen (#115).
 */
const MAX_VERSIONS_INLINE = 2;

export interface VersionCell {
  primary: string;
  /** Older versions shown after the primary, newest first, stepped back visually. */
  rest: string[];
  /** Versions that did not fit even as `rest` — 0 when everything is shown. */
  moreCount: number;
  /**
   * Whether `moreCount` deserves the major-line mark. A patch apart between
   * projects is housekeeping, a major apart is a difference in behaviour —
   * the same rule `frameworkPins` already applies for #82 — so this looks at
   * every other version, not only the ones folded into the count.
   */
  crossesMajor: boolean;
  /**
   * "N projects" / "N TFM" — the mark for the one case `moreCount` cannot
   * host it: every version already fits inline, so there is no count to
   * colour, yet the spread still crosses a major line. Decided on #115 in
   * favour of reviving the cell mockup's variant C for exactly this case,
   * over recolouring the separator or rendering an empty count.
   *
   * Undefined whenever `moreCount > 0` (the count carries the mark instead)
   * or the spread stays within one major line (nothing to mark at all).
   */
  axis?: string;
}

/** One resolved-version entry the cell and the tooltip are both built from. */
export interface SpreadEntry {
  projectPath: string;
  resolvedVersion: string;
  framework?: string;
}

/**
 * What the axis badge counts: distinct projects, or — for a spread within one
 * project — distinct frameworks. The raw entry count is neither: a project
 * pinned per framework (#82) contributes one entry per framework, so counting
 * entries directly over-reported "9 projects" for a package actually spread
 * across five, four of whose entries belonged to two multi-targeted projects.
 *
 * Both branches dedupe rather than trust the entry count directly — `dotnet
 * list` never reports the same framework twice for one project today, but
 * nothing here should quietly start over-counting the day it does, any more
 * than the project branch already refuses to.
 */
function axisCount(entries: readonly SpreadEntry[], withinOneProject: boolean | undefined): number {
  if (withinOneProject) return new Set(entries.map((e) => (e.framework ?? '').toLowerCase())).size;
  return new Set(entries.map((e) => normalizeFsPath(e.projectPath))).size;
}

export function versionCellFor(spread: ResolvedVersionSpread, entries: readonly SpreadEntry[]): VersionCell {
  const rest = spread.others.slice(0, MAX_VERSIONS_INLINE - 1).map((o) => o.version);
  const moreCount = spread.others.length - rest.length;
  const crossesMajor = spread.others.some((o) => !sameMajorLine(spread.primary, o.version));
  let axis: string | undefined;
  if (moreCount === 0 && crossesMajor) {
    const n = axisCount(entries, spread.withinOneProject);
    axis = spread.withinOneProject ? `${n} TFM` : `${n} project${n === 1 ? '' : 's'}`;
  }
  return { primary: spread.primary, rest, moreCount, crossesMajor, axis };
}

function byVersionDesc(a: { resolvedVersion: string }, b: { resolvedVersion: string }): number {
  return compareSemVer(b.resolvedVersion, a.resolvedVersion);
}

/**
 * The full breakdown behind the cell, in one of two shapes chosen by
 * `withinOneProject`: a spread between projects names each project once per
 * line, version first so a repeated one is visibly repeated; a spread
 * between one project's frameworks names that project once, in the heading,
 * rather than repeating it on every line. A project that is itself split by
 * framework, among several projects holding the package, keeps the project
 * shape and has its own frameworks indented underneath.
 *
 * Undefined for fewer than two entries — nothing to explain there.
 */
export function versionSpreadTooltip(
  entries: readonly SpreadEntry[],
  withinOneProject: boolean | undefined,
): string | undefined {
  if (entries.length < 2) return undefined;

  if (withinOneProject) {
    const rows = [...entries]
      .sort(byVersionDesc)
      .map((e) => `${e.resolvedVersion}  ${e.framework ?? ''}`.trimEnd());
    return [`Versions across frameworks — ${fileNameNoExt(entries[0].projectPath)}`, ...rows].join('\n');
  }

  // Keyed by the normalized path (#82's own `pairKey` does the same) rather than
  // the raw string, so a project `dotnet list` reports once in backslashes and
  // once in forward slashes still lands in a single group.
  const byProject = new Map<string, SpreadEntry[]>();
  for (const entry of entries) {
    const key = normalizeFsPath(entry.projectPath);
    const list = byProject.get(key);
    if (list) list.push(entry);
    else byProject.set(key, [entry]);
  }

  const groups = [...byProject.values()]
    .map((es) => {
      const sorted = [...es].sort(byVersionDesc);
      return { projectPath: sorted[0].projectPath, entries: sorted, highest: sorted[0].resolvedVersion };
    })
    .sort((a, b) => compareSemVer(b.highest, a.highest)
      || fileNameNoExt(a.projectPath).localeCompare(fileNameNoExt(b.projectPath)));

  const rows: string[] = ['Versions across projects'];
  for (const group of groups) {
    const name = fileNameNoExt(group.projectPath);
    const splitByFramework = new Set(group.entries.map((e) => e.resolvedVersion)).size > 1;
    if (splitByFramework) {
      rows.push(name);
      for (const e of group.entries) rows.push(`  ${e.resolvedVersion}  ${e.framework ?? ''}`.trimEnd());
    } else {
      rows.push(`${group.highest}  ${name}`);
    }
  }
  return rows.join('\n');
}
