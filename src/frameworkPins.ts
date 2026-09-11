/**
 * Per-target-framework pins (#82).
 *
 * A multi-targeted project can reference one package at a different version per
 * TFM, through conditional `<PackageReference>` groups. `dotnet list` reports
 * those as separate entries that share a project path and differ only in
 * `framework`, and everything downstream used to key on the package id alone —
 * so one TFM's version was picked arbitrarily for both, and the write that
 * followed carried no `--framework` and collapsed every conditional group onto
 * it.
 *
 * The rule this module encodes: a package is treated per framework only where
 * some project actually pins it per framework. Everywhere else — every
 * single-target project, and every multi-target project holding one
 * unconditional reference — the id keeps behaving exactly as it did.
 */

import { compareSemVer } from './semver';
import { normalizeFsPath, packageIdsEqual, pathsEqual } from './pathCompare';
import { compareTargetFrameworks } from './targetFrameworks';
import type { InstalledPackage } from './types';

/** One framework's pin of a package inside one project. */
export interface FrameworkPin {
  framework: string;
  resolvedVersion: string;
  requestedVersion?: string;
}

/** Leading major of a version, or undefined when it does not start with digits. */
function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version.trim());
  return m ? parseInt(m[1], 10) : undefined;
}

/** Key for the (package, project) pair a pin belongs to. */
function pairKey(packageId: string, projectPath: string): string {
  return `${packageId.toLowerCase()}\0${normalizeFsPath(projectPath)}`;
}

/**
 * The (package, project) pairs that are pinned per framework — one project
 * holding more than one resolved version for the id across its frameworks.
 *
 * Pairs, not bare ids, and that distinction is the whole point: pinning is a
 * property of one project's file. Keyed by id alone, a single project pinning a
 * package per TFM would drag every other project referencing that id into
 * per-framework handling — capping their update to their own major line and
 * sending a `--framework` they never asked for, because of a neighbour's
 * configuration.
 *
 * Entries with no `framework` cannot take part: `dotnet list` always reports
 * one, and an entry without it carries no evidence either way.
 */
export function frameworkScopedPins(installed: readonly InstalledPackage[]): Set<string> {
  const versionsPerPair = new Map<string, Set<string>>();
  for (const pkg of installed) {
    if (!pkg.framework) continue;
    const key = pairKey(pkg.id, pkg.projectPath);
    const set = versionsPerPair.get(key);
    if (set) set.add(pkg.resolvedVersion);
    else versionsPerPair.set(key, new Set([pkg.resolvedVersion]));
  }

  const scoped = new Set<string>();
  for (const [key, versions] of versionsPerPair) {
    if (versions.size > 1) scoped.add(key);
  }
  return scoped;
}

/** Whether this entry's own project pins this package per framework. */
export function isFrameworkScoped(
  pkg: InstalledPackage,
  scopedPins: ReadonlySet<string>,
): boolean {
  return !!pkg.framework && scopedPins.has(pairKey(pkg.id, pkg.projectPath));
}

/**
 * Grouping key for an entry: the id alone, unless this entry's own project pins
 * the package per framework, in which case each framework gets its own bucket
 * and its own update target. Callers pass the set once rather than recomputing
 * it per entry.
 */
export function pinGroupKey(pkg: InstalledPackage, scopedPins: ReadonlySet<string>): string {
  const id = pkg.id.toLowerCase();
  if (!isFrameworkScoped(pkg, scopedPins)) return id;
  return `${id}\0${(pkg.framework as string).toLowerCase()}`;
}

/**
 * The pins one project holds for one package id, newest framework first —
 * `net10.0`, `net9.0`, `net8.0`, then `netstandard2.0`, then `net48`. Sorted as
 * monikers rather than as text, which is what `compareTargetFrameworks` exists
 * for (#86): alphabetically `net11.0` precedes `net9.0`, and `net48` looks
 * larger than `net8.0` while being six years older.
 *
 * Entries with no framework are dropped: a row claiming to be about a framework
 * has to know which one.
 */
export function frameworkPinsFor(
  installed: readonly InstalledPackage[],
  packageId: string,
  projectPath: string,
): FrameworkPin[] {
  return installed
    .filter((i) =>
      !!i.framework
      && packageIdsEqual(i.id, packageId)
      && pathsEqual(i.projectPath, projectPath))
    .map((i) => ({
      framework: i.framework as string,
      resolvedVersion: i.resolvedVersion,
      requestedVersion: i.requestedVersion,
    }))
    .sort((a, b) => compareTargetFrameworks(a.framework, b.framework));
}

/**
 * Whether this project's frameworks disagree about the version — the only case
 * worth splitting a row over. Two frameworks holding the same version are one
 * unconditional reference as far as the reader is concerned, and they get the
 * single row they have today.
 */
export function pinsDiverge(pins: readonly FrameworkPin[]): boolean {
  return new Set(pins.map((p) => p.resolvedVersion)).size > 1;
}

/**
 * The version an update should propose for a framework pinned to `current`:
 * the highest one inside the same major line. A per-framework pin exists to
 * keep `net9.0` on 9.x while `net10.0` moves through 10.x, so crossing the
 * boundary is exactly what it is asking not to happen — which is what plain
 * `dotnet list --outdated` does, offering 10.0.12 for a `net9.0` entry.
 * Matching `--outdated --highest-minor` instead.
 *
 * The picker still lists every version; this only decides what the button
 * proposes. Undefined when nothing newer exists inside the line, or when
 * `current` has no numeric major to stay inside of.
 */
export function latestInLine(current: string, versions: readonly string[]): string | undefined {
  const line = majorOf(current);
  if (line === undefined) return undefined;
  return versions
    .filter((v) => majorOf(v) === line && compareSemVer(v, current) > 0)
    .sort((a, b) => compareSemVer(b, a))[0];
}

/**
 * Whether two versions belong to the same major line. Used to decide when a
 * per-package change needs confirming: a batch update never leaves the line a
 * framework is pinned to, so a change that does is always a deliberate one, and
 * the person making it is the only one who knows whether the pin was about
 * framework support or about history (#82).
 *
 * A version with no numeric major is treated as being in nobody's line, so it
 * never triggers a confirmation on its own account.
 */
export function sameMajorLine(a: string, b: string): boolean {
  const la = majorOf(a);
  const lb = majorOf(b);
  return la !== undefined && la === lb;
}

/**
 * The framework pins, among `projectPaths`, that `version` would take out of
 * their major line (#82). Empty when nothing is pinned per framework there, or
 * when every pin is already in that line — which is the ordinary case, so the
 * confirmation this feeds never appears for a package nobody pinned.
 */
export function pinsCrossedBy(
  installed: readonly InstalledPackage[],
  packageId: string,
  projectPaths: readonly string[],
  version: string,
): Array<{ framework: string; version: string }> {
  if (!version) return [];
  const scoped = frameworkScopedPins(installed);
  const crossed = new Map<string, string>();
  for (const pkg of installed) {
    if (!packageIdsEqual(pkg.id, packageId)) continue;
    if (!projectPaths.some((p) => pathsEqual(p, pkg.projectPath))) continue;
    if (!isFrameworkScoped(pkg, scoped)) continue;
    if (sameMajorLine(pkg.resolvedVersion, version)) continue;
    crossed.set(pkg.framework as string, pkg.resolvedVersion);
  }
  return [...crossed]
    .map(([framework, pinned]) => ({ framework, version: pinned }))
    .sort((a, b) => compareTargetFrameworks(a.framework, b.framework));
}

/** One row under a project: a framework, and the version pinned for it if any. */
export interface FrameworkRow {
  framework: string;
  /** Undefined when the package is not referenced from this framework at all. */
  resolvedVersion?: string;
}

/**
 * The rows a project contributes for one package: one per target framework the
 * project declares, carrying the pinned version where there is one.
 *
 * Frameworks the package is missing from are the point of listing the project's
 * own set rather than the package's: a project targeting `net8.0;net9.0;net10.0`
 * with the package pinned in two of them had no way to reference it from the
 * third, because nothing on screen knew that third framework existed.
 *
 * Falls back to the frameworks the package itself is reported under when the
 * project's set is unknown — a refresh that could not read it should show the
 * rows it can rather than none. Newest first, the same order the badges use
 * everywhere else (#86).
 */
export function frameworkRowsFor(
  installed: readonly InstalledPackage[],
  packageId: string,
  projectPath: string,
  projectFrameworks: readonly string[] | undefined,
): FrameworkRow[] {
  const pins = frameworkPinsFor(installed, packageId, projectPath);
  const known = projectFrameworks?.length ? projectFrameworks : pins.map((p) => p.framework);
  return [...new Set(known)]
    .sort(compareTargetFrameworks)
    .map((framework) => ({
      framework,
      resolvedVersion: pins.find((p) => p.framework === framework)?.resolvedVersion,
    }));
}

/**
 * Whether these rows are worth showing instead of the project's single row.
 *
 * Two reasons, and only these: the frameworks disagree about the version, or
 * one of them has no reference while another does. Anything else is a package
 * that behaves the same everywhere in the project — one `PackageReference`, as
 * far as the reader is concerned — and it keeps the row it has always had.
 */
export function needsFrameworkRows(rows: readonly FrameworkRow[]): boolean {
  if (rows.length < 2) return false;
  const versions = new Set(rows.map((r) => r.resolvedVersion ?? ''));
  return versions.size > 1;
}

/**
 * Width for one framework badge, so the version controls beside them line up
 * (#82).
 *
 * A step per family of names rather than one column for the whole group: a
 * project that targets `net6.0` through `net10.0` and `netstandard2.0` would
 * otherwise carry a column sized for the longest, and the four short badges
 * would sit in a field of empty space. Stepped, the short ones line up with
 * each other, `netstandard2.0` lines up with anything like it, and a name too
 * long for either — a RID-qualified `net8.0-windows10.0.19041.0` — keeps its
 * own width instead of dragging every other badge out with it.
 */
export function tfmBadgeWidth(framework: string): string | undefined {
  if (framework.length === 0) return undefined;
  if (framework.length <= 8) return '4.6em';
  if (framework.length <= 15) return '7.6em';
  return undefined;
}

/**
 * The projects, among those narrowed to a subset of their frameworks, whose
 * reference would have to be split for that narrowing to mean anything (#82).
 *
 * A reference the project states once, for every framework at once, cannot be
 * narrowed by `dotnet add --framework` — the host rebuilds it into one group
 * per framework instead. That is a change to the shape of the project file, so
 * it is worth saying before it happens rather than after.
 *
 * Read the same way the project rows read it: frameworks that agree on a
 * version are one reference as far as anything outside the file can tell.
 * `dotnet list` cannot separate that from two conditional groups that happen to
 * agree, so this is an approximation on purpose — a safe one, because the host
 * checks the file before it writes and falls back to the plain framework write
 * when the groups turn out to be there already. A package the project does not
 * reference yet is never included: there is nothing to split, and the write
 * creates the conditional group itself.
 */
export function narrowingSplitsReference(
  installed: readonly InstalledPackage[],
  packageId: string,
  projectPath: string,
  projectFrameworks: readonly string[] | undefined,
): boolean {
  const pins = frameworkPinsFor(installed, packageId, projectPath);
  if (pins.length === 0) return false;
  return !needsFrameworkRows(frameworkRowsFor(installed, packageId, projectPath, projectFrameworks));
}
