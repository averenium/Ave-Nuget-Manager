/**
 * What the dependents proposal answers with (#109) — the shapes that cross the
 * message channel and that the popup and the page draw. Kept apart from the
 * walk itself so the webview can import them without the host's modules.
 */

import type { VersionDependencyDiff } from './packageVersionDiff';
import type { ReleaseNotesLink } from './packageLinks';

/** A closure larger than this opens on a page instead of in a popup. */
export const CASCADE_POPUP_ROWS = 10;

/**
 * - `apply`: a write is waiting. Only an actual restore warning counts — a
 *   resolved version outside a declared range (`NU1608`/`NU1605`).
 * - `asked`: the person asked about this row. A bare minimum the target crosses
 *   by a major counts as well (case 3, the one nothing in the toolchain warns
 *   about).
 */
export type CascadeMode = 'apply' | 'asked';

export type UnknownCode =
  | 'not-direct'
  | 'blocked'
  | 'no-dependency-data'
  | 'unreachable'
  | 'registration-too-large'
  | 'credential-refused'
  | 'feed-error'
  | 'too-deep'
  | 'too-many'
  /** A project under a central write that has no restore graph yet. */
  | 'not-restored';

/** Why a dependent could not be judged. `label` fits a row's range slot; `detail` is the full sentence. */
export interface UnknownReason {
  code: UnknownCode;
  label: string;
  detail: string;
}

/** One version of a dependent, with the range it declares for the package it hangs from. */
export interface WindowEntry {
  version: string;
  /** Absent when this version declares no dependency on the parent at all. */
  range?: string;
  /** Whether this version's declared range lets the parent's new version in. */
  admits: boolean;
  /** Excluded as a proposal: unlisted, deprecated, vulnerable. */
  flagged?: 'deprecated' | 'vulnerable';
}

/**
 * Three kinds of row beside the dead end, because they are three different
 * things to the person who presses *Take all*:
 * - `moves`: judged, and proposed.
 * - `unknown`: *not judged* — the feed could not say. A set with one is
 *   incomplete without anyone having chosen it.
 * - `left-out`: judged, and not proposed on purpose — a dependent whose updates
 *   are blocked, or that is not a direct reference. A set with one is
 *   incomplete by choice, and the row says what to do about it.
 */
/**
 * One thing that fixes where a row's version can be, named for the dead end that
 * two of them make (#109).
 * - `requires`: `id` at `version` — a package that moves — declares the row's
 *   package in `range`, so the row has to end up inside it.
 * - `admits`: the row hangs from `id`, which goes to `version`; the row's own
 *   range for it has to let that in.
 * - `fixed`: `id` stays at `version`, the one the person chose; the row must not
 *   declare a range that leaves it out.
 * - `floor`: `id` is a project this one references, and it requires the row's
 *   package at `range` or more — a version below it would not restore.
 */
export interface CascadeConstraint {
  id: string;
  version?: string;
  kind: 'requires' | 'admits' | 'fixed' | 'floor';
  range?: string;
  /** Under a central version, the projects (paths) whose graph this constraint comes from. */
  projects?: string[];
}

export type CascadeNodeStatus = 'moves' | 'unknown' | 'left-out' | 'dead-end';

export interface CascadeNode {
  id: string;
  /** The version the project restored. */
  installedVersion: string;
  /** What it is proposed to move to — absent unless `status` is `moves`. */
  proposedVersion?: string;
  /** The range the proposed version declares for its parent. */
  range?: string;
  /** The range the installed version declares for its parent — what the restore actually checked. */
  installedRange?: string;
  /** The package this one hangs from (the one that forces it to move). Absent on the root. */
  parentId?: string;
  /**
   * Which way the edge to its parent runs. Absent: the row *depends on* its
   * parent, and `range` is what the row declares for it. `forward`: the parent's
   * new version *requires* the row, and `range` is what the parent requires of
   * it — one range, the same for every version of the row, so `window` entries
   * carry no range of their own and `admits` means "satisfies it".
   */
  direction?: 'forward';
  /**
   * Under central package management, the projects whose restore graph held
   * this row's edge (paths). Absent for an ordinary, single-project closure.
   */
  projects?: string[];
  /** The project a write for this row goes through — one that references it directly. Set with `projects`. */
  writeIn?: string;
  /** The row stands for a project that could not be judged, not for a package. */
  project?: boolean;
  /**
   * The row moves, but nothing is written for it: it is not a direct reference.
   * NuGet lowers (or raises) a transitive by itself once every package that holds
   * it has moved, so the walk follows it to find those packages, and the row says
   * it moves with the ones above.
   */
  virtual?: boolean;
  /** Every range a package that moves declares for this row, the one from its parent first. */
  requirements?: Array<{ id: string; version: string; range: string }>;
  /** For a dead end between several constraints: all of them, so the reader sees what cannot both hold. */
  constraints?: CascadeConstraint[];
  status: CascadeNodeStatus;
  reason?: UnknownReason;
  /** The proposal is itself marked — nothing unmarked admitted the target. */
  flagged?: 'deprecated' | 'vulnerable';
  /** The ranges every version declares, for a dead end: why nothing admits the target. */
  deadEndRanges?: string[];
  window?: WindowEntry[];
  /** Versions of the dependent older / newer than the window shows, for "… N older" on the page. */
  windowOlder?: number;
  windowNewer?: number;
  sourceName?: string;
  diff?: VersionDependencyDiff;
  /** The proposed version's release notes, when its package names them — read after the walk, within a short budget. */
  releaseNotes?: ReleaseNotesLink;
  /** Other members of the closure this one also declares an edge to. */
  alsoDeclared?: Array<{ id: string; range: string }>;
  children: CascadeNode[];
}

export type CascadeOutcome =
  /** Nothing has to move. */
  | 'clear'
  /** Something moves; possibly with some dependents that could not be judged. */
  | 'proposal'
  /** A dependent whose every version rules the target out. */
  | 'dead-end'
  /** Every dependent that would need to move could not be judged. */
  | 'unknown';

export interface CascadeResult {
  outcome: CascadeOutcome;
  mode: CascadeMode;
  packageId: string;
  fromVersion: string;
  toVersion: string;
  projectPath: string;
  framework: string;
  root: CascadeNode;
  /** Dependents proposed to move — the root is not counted. */
  moves: number;
  /** Dependents that could not be judged. */
  unknowns: number;
  /** Dependents that were judged and are not proposed on purpose: blocked, or not a direct reference. */
  leftOut: number;
  /** The first dead end met, when `outcome` is `dead-end`. */
  deadEnd?: CascadeNode;
  /** Other frameworks of the same project whose answer differs. */
  otherFrameworks?: string[];
  /**
   * Set when the version is held centrally and more than one project uses it:
   * one closure for the whole set, not one per project. `framework` then names
   * no one framework — every (project, framework) pair contributed.
   */
  central?: {
    propsFile: string;
    /** Every project in the set, as paths, the ones that were walked and the ones that could not be. */
    projects: string[];
    /** The frameworks of all of them together. */
    frameworks: string[];
  };
}

/**
 * Every package the closure would write, root first — what "Take all" sends, and
 * what "Update anyway" sends: what was established.
 *
 * In a dead end nothing was. The popup for it shows no tree — only the one
 * reason and the decision — so a dependent that happened to be found moving
 * beside the dead end would be written without the person ever having seen it.
 * There it is the root alone, the same write "Update only this package" makes.
 */
export function movesOf(result: CascadeResult): Array<{ packageId: string; fromVersion: string; toVersion: string; writeIn?: string }> {
  const out: Array<{ packageId: string; fromVersion: string; toVersion: string; writeIn?: string }> = [];
  const walk = (node: CascadeNode): void => {
    if (result.outcome === 'dead-end' && node !== result.root) return;
    // A virtual row is a transitive: there is no reference to write.
    if (node.status === 'moves' && node.proposedVersion && !node.virtual) {
      out.push({
        packageId: node.id, fromVersion: node.installedVersion, toVersion: node.proposedVersion,
        ...(node.writeIn ? { writeIn: node.writeIn } : {}),
      });
    }
    node.children.forEach(walk);
  };
  walk(result.root);
  return out;
}

/** How many rows of the closure move with the ones above them and are not written. */
export function impliedCount(result: CascadeResult): number {
  let n = 0;
  const walk = (node: CascadeNode): void => {
    if (node.virtual && node.status === 'moves') n += 1;
    node.children.forEach(walk);
  };
  walk(result.root);
  return n;
}

/** Whether the closure is too large to read in a popup. */
export function isLargeClosure(result: CascadeResult): boolean {
  return result.moves + result.unknowns + result.leftOut + impliedCount(result) > CASCADE_POPUP_ROWS;
}
