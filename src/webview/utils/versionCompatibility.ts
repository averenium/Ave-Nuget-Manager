import type { DeclaredDependencyGroup, VersionFlag } from '../../types';
import { unsatisfiedFrameworks } from '../../frameworkCompatibility';
import { frameworkLabel } from '../../frameworkMoniker';
import { versionsEqual } from '../../semver';

/**
 * Why one version's declared groups can't serve `projectTfms` — undefined
 * when they can, or when there's nothing to judge (#107). The one place the
 * "Can't install for X — ships Y only" sentence is built, shared by the
 * version list's disclosure and the multi-project install popup alike.
 *
 * Names only the framework(s) `unsatisfiedFrameworks` actually failed on, not
 * every one of `projectTfms` — a version that ships net10.0 only works fine
 * for a net10.0 project, and a message pairing it with a net9.0 project it
 * *doesn't* work for must not read as though it fails for net10.0 too.
 */
export function incompatibilityReason(
  groups: DeclaredDependencyGroup[] | undefined,
  projectTfms: readonly string[],
): string | undefined {
  const failing = unsatisfiedFrameworks(groups, projectTfms);
  if (failing.length === 0) return undefined;
  const forWhat = [...new Set(failing.map(frameworkLabel))].join(', ');
  const shipped = [...new Set(
    (groups ?? []).map((g) => g.targetFramework).filter((f): f is string => !!f).map(frameworkLabel),
  )];
  return shipped.length > 0
    ? `Can't install for ${forWhat} — no compatible assets (ships ${shipped.join(', ')} only)`
    : `Can't install for ${forWhat}`;
}

/**
 * Which of a package's versions the project's own target framework(s) cannot
 * use, and why (#107) — the decision behind the version list's disclosure,
 * the update mark's default, and the Groups family intersection alike, kept
 * out of the components so it is testable without a React harness, the same
 * way `declaredGroups.ts` already is for #114.
 */
export interface VersionCompatibility {
  /** Versions incompatible with `projectTfms`, in the order they were given. */
  incompatible: readonly string[];
  /** Tooltip text for an incompatible version; undefined for a compatible one. */
  reason(version: string): string | undefined;
}

const NONE: VersionCompatibility = { incompatible: [], reason: () => undefined };

/**
 * `projectTfms` empty or absent means the caller does not know which
 * framework(s) are relevant — nothing is judged, exactly like `isVersionCompatible`
 * itself. A version the feed never described (`declaredDependencies` absent)
 * is never marked incompatible either: the feed's silence is not a claim.
 */
export function compatibilityFor(
  versions: readonly string[],
  versionFlags: Record<string, VersionFlag> | undefined,
  projectTfms: readonly string[] | undefined,
): VersionCompatibility {
  if (!projectTfms?.length || !versionFlags) return NONE;

  const incompatible: string[] = [];
  const reasons = new Map<string, string>();

  for (const v of versions) {
    const reason = incompatibilityReason(versionFlags[v]?.declaredDependencies, projectTfms);
    if (!reason) continue;
    incompatible.push(v);
    reasons.set(v, reason);
  }

  if (incompatible.length === 0) return NONE;
  return { incompatible, reason: (v) => reasons.get(v) };
}

/**
 * The incompatible versions a picker should actually hide behind its
 * disclosure — every one of `compat.incompatible` except `selected`, however
 * `selected` happens to be spelled (#107). Compared through `versionsEqual`
 * rather than `===`: the two sides can come from different call sites (an
 * installed row's resolved version vs. the feed's own version string), and a
 * spelling mismatch here would silently drop the current selection out of
 * the visible list on open — the one thing the disclosure design insists
 * must never happen.
 */
export function hiddenVersions(compat: VersionCompatibility, selected: string): string[] {
  return compat.incompatible.filter((v) => !versionsEqual(v, selected));
}
