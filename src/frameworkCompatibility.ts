import {
  FAMILY_CORE,
  FAMILY_FRAMEWORK,
  FAMILY_MODERN,
  FAMILY_STANDARD,
  parseTargetFramework,
  type ParsedTargetFramework,
} from './targetFrameworks';
import { frameworkKey } from './frameworkMoniker';

/**
 * Which dependency group a project's framework would actually take (#114).
 *
 * A package that declares groups for `net8.0` and `netstandard2.0` supports a
 * `net10.0` project perfectly well — restore takes the `net8.0` group. Asking
 * only for an exact match therefore reported "no group for net10.0" about a
 * package with two groups that apply, which is worse than saying nothing: it is
 * a claim, and it is wrong.
 *
 * So the nearest compatible group is picked, the same way restore picks it. The
 * rules below are a deliberate subset — the ones that decide real packages —
 * and they are conservative in the direction that matters: an unrecognised
 * moniker is compatible with nothing but itself, so an unusual package falls
 * back to "the feed declares groups for X only" rather than to a wrong pick.
 * Asset fallback (`PackageTargetFallback`, and the .NET Framework compatibility
 * shim) is not modelled at all: it is configuration this panel cannot see, and
 * guessing at it would be inventing a fact.
 */

/**
 * Whether a project targeting `projectTfm` can take the group declared for
 * `groupTfm`.
 *
 * A group naming no framework at all applies to everything, and is handled by
 * the caller rather than here — there is no moniker to compare.
 */
export function frameworkAccepts(projectTfm: string, groupTfm: string): boolean {
  if (frameworkKey(groupTfm) === frameworkKey(projectTfm)) return true;
  const project = parseTargetFramework(frameworkKey(projectTfm));
  const group = parseTargetFramework(frameworkKey(groupTfm));

  // A platform-specific group is for that platform only. `net8.0-windows`
  // cannot serve a plain `net10.0` project, though `net8.0` serves
  // `net10.0-windows` — a platform target is the plain one plus extras.
  if (group.platform && group.platform !== project.platform) return false;

  switch (project.family) {
    case FAMILY_MODERN:
      // .NET 5 and later took over from .NET Core and can consume everything it
      // could, plus .NET Standard up to the last version there ever was.
      if (group.family === FAMILY_MODERN) return notNewerThan(group, project);
      if (group.family === FAMILY_CORE) return true;
      return group.family === FAMILY_STANDARD && atMost(group, [2, 1]);
    case FAMILY_CORE:
      if (group.family === FAMILY_CORE) return notNewerThan(group, project);
      return group.family === FAMILY_STANDARD && atMost(group, [2, 1]);
    case FAMILY_FRAMEWORK:
      // .NET Framework reaches .NET Standard 2.0 and no further, and only from
      // 4.6.1 up — below that the promise was never kept in practice.
      if (group.family === FAMILY_FRAMEWORK) return notNewerThan(group, project);
      return group.family === FAMILY_STANDARD
        && atMost(group, [2, 0])
        && atLeast(project, [4, 6, 1]);
    case FAMILY_STANDARD:
      return group.family === FAMILY_STANDARD && notNewerThan(group, project);
    default:
      return false;
  }
}

/**
 * The group a project would take, from the groups a version declares — the
 * nearest compatible one, which is the one restore would choose.
 *
 * `undefined` means the feed declares nothing this project can use, which is a
 * finding the panel states carefully: a package may still ship assets for a
 * framework it declares no dependencies for.
 */
export function selectCompatibleGroup<T extends { targetFramework?: string }>(
  groups: readonly T[],
  projectTfm: string | undefined,
): T | undefined {
  const catchAll = groups.find((g) => !frameworkKey(g.targetFramework));
  if (!projectTfm) return catchAll;

  const compatible = groups
    .filter((g) => frameworkKey(g.targetFramework) && frameworkAccepts(projectTfm, g.targetFramework!))
    .sort((a, b) => distance(projectTfm, a.targetFramework!) - distance(projectTfm, b.targetFramework!));

  // The catch-all group is the last resort, never a rival to a named one: a
  // group written for this framework's family says more about it than one
  // written for none.
  return compatible[0] ?? catchAll;
}

/**
 * How far a group is from the project, smaller being nearer. Family first — a
 * group of the project's own family beats a portable one however new — then the
 * platform, then the version gap.
 */
function distance(projectTfm: string, groupTfm: string): number {
  const project = parseTargetFramework(frameworkKey(projectTfm));
  const group = parseTargetFramework(frameworkKey(groupTfm));
  const familyRank = group.family === project.family ? 0 : group.family === FAMILY_CORE ? 1 : 2;
  const platformRank = group.platform === project.platform ? 0 : 1;
  // Newer is nearer, and the gap is bounded well below the ranks above so a
  // closer family always wins over a higher version.
  const versionGap = Math.max(0, 999 - ((group.version[0] ?? 0) * 10 + (group.version[1] ?? 0)));
  return familyRank * 1_000_000 + platformRank * 10_000 + versionGap;
}

function notNewerThan(group: ParsedTargetFramework, project: ParsedTargetFramework): boolean {
  return atMost(group, project.version);
}

function atMost(framework: ParsedTargetFramework, ceiling: number[]): boolean {
  return compare(framework.version, ceiling) <= 0;
}

function atLeast(framework: ParsedTargetFramework, floor: number[]): boolean {
  return compare(framework.version, floor) >= 0;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
