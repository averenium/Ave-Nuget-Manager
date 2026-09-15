import type { DeclaredDependencyGroup } from './types';
import { frameworkKey } from './frameworkMoniker';
import { defaultGroupFor } from './frameworkCompatibility';
import { packageIdsEqual } from './pathCompare';

/**
 * What taking the selected version would change, beside the version number
 * (#114).
 *
 * Both versions' entries come out of the same registration pages, so the
 * difference costs nothing to compute — it is the one thing an update can be
 * asked about that the toolchain answers nowhere. `dotnet list --outdated` says
 * a newer version exists and stops; the manifest diff shows a version number;
 * restore succeeds either way and the consequence lands later.
 *
 * **The licence is deliberately not one of these rows.** #89 owns that fact and
 * puts it in Problems, where a consequence belongs, and saying it twice would be
 * two designs for one thing. It travels in the same answer as this, because
 * asking about the same two versions twice is two round trips for one question —
 * but it is rendered where it already lives.
 */

/** One dependency the update would add, raise or drop. */
export interface DependencyChange {
  id: string;
  /** The range the installed version declares. Absent when the dependency is new. */
  from?: string;
  /** The range the selected version declares. Absent when it is dropped. */
  to?: string;
}

export interface VersionDependencyDiff {
  added: DependencyChange[];
  /** The declared range moved. Whether that is a raise is not read: a range is compared as written. */
  changed: DependencyChange[];
  dropped: DependencyChange[];
  /**
   * Frameworks the installed version declares a group for and the selected one
   * does not — reported only for frameworks the workspace actually uses, since a
   * package dropping support for something nobody targets is not a consequence.
   */
  frameworksDropped: string[];
}

/** True when nothing about the dependencies would move. */
export function isEmptyDiff(diff: VersionDependencyDiff): boolean {
  return diff.added.length === 0
    && diff.changed.length === 0
    && diff.dropped.length === 0
    && diff.frameworksDropped.length === 0;
}

/**
 * The difference between two versions' declared dependencies, for the framework
 * an install would actually use.
 *
 * Compared per framework rather than across all groups at once: a package that
 * declares different dependencies for `net8.0` and `netstandard2.0` would
 * otherwise report every difference between the two as a change the update
 * makes, which it is not.
 *
 * Ranges are compared as written, after trimming. Deciding that `>= 8.0.0`
 * became `>= 8.0.4` is a *raise* means ordering two ranges, which is a judgement
 * about what restore will pick inside them — the one thing this section has said
 * from the start it does not know.
 */
export function versionDependencyDiff(
  installed: DeclaredDependencyGroup[] | undefined,
  selected: DeclaredDependencyGroup[] | undefined,
  /** Every framework the workspace targets, newest first. */
  projectFrameworks: readonly string[],
): VersionDependencyDiff {
  const empty: VersionDependencyDiff = {
    added: [], changed: [], dropped: [], frameworksDropped: [],
  };
  // Nothing to compare is not the same as nothing changing, and this says the
  // former by answering the latter's shape — the caller renders nothing either
  // way, and inventing a difference from an absent side would be a guess.
  if (!installed || !selected) return empty;

  const target = projectFrameworks[0];
  // The same picker the section uses, including its answer when no project
  // framework is known — without that, an empty framework list compared two
  // empty groups and reported that nothing changes.
  const before = defaultGroupFor(installed, target)?.dependencies ?? [];
  const after = defaultGroupFor(selected, target)?.dependencies ?? [];

  const added: DependencyChange[] = [];
  const changed: DependencyChange[] = [];
  const dropped: DependencyChange[] = [];

  for (const now of after) {
    const was = before.find((d) => packageIdsEqual(d.id, now.id));
    if (!was) {
      added.push({ id: now.id, to: now.range });
    } else if (!sameRange(was.range, now.range)) {
      changed.push({ id: now.id, from: was.range, to: now.range });
    }
  }
  for (const was of before) {
    if (!after.some((d) => packageIdsEqual(d.id, was.id))) {
      dropped.push({ id: was.id, from: was.range });
    }
  }

  // A framework the newer version stops *serving* is its own row, and only for
  // frameworks this workspace targets: a package dropping `net472` is no
  // consequence to a solution that targets none.
  //
  // Asked through the same picker as everything else, never by looking for the
  // framework's own key among the declared groups. A version that declares
  // `.NETFramework4.7.2` and `netstandard2.0`, and a next version declaring only
  // `netstandard2.0`, still serves a `net472` project through that group —
  // restore passes without a word, and a row saying it "stops declaring net472"
  // claims a consequence that does not exist. The difference between declaring a
  // group for a framework and supporting it is the distinction the whole section
  // is careful about; it has to hold here too.
  const frameworksDropped = projectFrameworks
    .filter((tfm) => defaultGroupFor(installed, tfm) && !defaultGroupFor(selected, tfm))
    .map((tfm) => frameworkKey(tfm))
    .filter(Boolean);

  return { added, changed, dropped, frameworksDropped: [...new Set(frameworksDropped)] };
}

/** Spacing carries no meaning; everything else about a range does. */
function sameRange(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').replace(/\s+/g, '') === (b ?? '').replace(/\s+/g, '');
}
