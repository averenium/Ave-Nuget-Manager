import { promises as fs } from 'fs';
import { declaredReferences } from './declaredReferences';
import { packageIdsEqual, pathsEqual } from './pathCompare';
import { parseNuGetVersionRange } from './packageVersionRanges';
import { versionsEqual } from './semver';
import { findNearestPackagesProps } from './projectFileSnapshot';
import { readRestoreOutcome, type RestoreOutcome } from './restoreOutcome';
import type { InstalledPackage, UnresolvedReference } from './types';

/**
 * The references a project declares that restore could not put in its graph
 * (#138). `dotnet list package --no-restore` reports the graph, so it cannot
 * name them: a reference restore failed on is in neither `targets` nor
 * `libraries`, and exits 0 with no mention of it.
 *
 * Three cases, told apart, because they are three different things to say:
 * - restore logged an error for it — the reason is the log's own;
 * - it is declared, absent, and the project file is newer than what restore last
 *   wrote — *not restored yet*, which is not an error and has no reason;
 * - anything else — nothing is known, and nothing is said. A missing or
 *   malformed cache never turns into a claim that something is wrong.
 */

interface FileRead {
  xml: string;
  mtimeMs: number;
  path: string;
}

export interface UnresolvedDeps {
  readProject(projectPath: string): Promise<FileRead | null>;
  readProps(projectPath: string): Promise<FileRead | null>;
  readOutcome(projectPath: string): Promise<RestoreOutcome | null>;
}

async function readFileRead(file: string): Promise<FileRead | null> {
  try {
    const [xml, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { xml, mtimeMs: stat.mtimeMs, path: file };
  } catch {
    return null;
  }
}

export const realUnresolvedDeps: UnresolvedDeps = {
  readProject: (projectPath) => readFileRead(projectPath),
  readProps: async (projectPath) => {
    const props = await findNearestPackagesProps(projectPath);
    return props ? readFileRead(props) : null;
  },
  readOutcome: readRestoreOutcome,
};

/**
 * What to say about one project: the declared references that are not in its
 * listing, each with why. `installed` is the whole solution's list; only the
 * entries of `projectPath` count.
 */
export async function unresolvedForProject(
  projectPath: string,
  installed: readonly InstalledPackage[],
  deps: UnresolvedDeps = realUnresolvedDeps,
): Promise<InstalledPackage[]> {
  const project = await deps.readProject(projectPath);
  if (!project) return [];
  const props = await deps.readProps(projectPath);
  const declared = declaredReferences(project.xml, props?.xml);
  if (declared.length === 0) return [];

  const listed = installed.filter((p) => pathsEqual(p.projectPath, projectPath));
  const missing = declared.filter((d) => !listed.some((p) => packageIdsEqual(p.id, d.id)));
  if (missing.length === 0) return [];

  // No cache, or one that cannot be read, is nothing known — never a claim that
  // something is wrong. Restore has to have said something before this does.
  const outcome = await deps.readOutcome(projectPath);
  if (!outcome) return [];
  // A project file edited after restore last wrote its cache has not been
  // restored since; the props file counts, since a central version lives there.
  const editedSince = outcome.writtenAt !== undefined
    && (project.mtimeMs > outcome.writtenAt || (props?.mtimeMs ?? 0) > outcome.writtenAt);

  const out: InstalledPackage[] = [];
  for (const d of missing) {
    const failure = outcome.failures.find((f) => packageIdsEqual(f.libraryId, d.id));
    let unresolved: UnresolvedReference | undefined;
    if (failure && editedSince && wasAboutAnotherVersion(failure.message, d.version)) {
      // The log says "(>= 99.99.99)" and the project now says 13.0.3: the message
      // is about a version nobody has asked restore for since. Showing it beside
      // the new version would put an old answer next to a new question.
      unresolved = { notRestored: true };
    } else if (failure) {
      unresolved = { code: failure.code, message: failure.message, frameworks: failure.frameworks };
    } else if (editedSince && !d.conditional) {
      unresolved = { notRestored: true };
    }
    if (!unresolved) continue;
    out.push({
      id: d.id,
      requestedVersion: d.version,
      // The panel's own mechanics (the picker, the check that says "this is the
      // version") read the resolved version; for a reference that never resolved
      // the declared one is the version it stands on.
      resolvedVersion: d.version,
      projectPath,
      unresolved,
    });
  }
  return out;
}

/**
 * Whether a restore message names a version other than the one the project file
 * declares now — only meaningful once the file has been edited since.
 *
 * `NU1102` closes with the range it looked for in NuGet's normalized form, which
 * is not prose and is not translated: `(>= 99.99.99)` for a bare version,
 * `(= 99.99.99)` for `[99.99.99]`, `(> 97.0.0)` for `(97.0.0, )`, `(>= 98.0.0 && < 99.0.0)`
 * for an interval (measured, with the English SDK). So the lower bound is read
 * from the parenthesis, whatever language wraps it, and compared with the lower
 * bound of the declared range. `NU1101` is about the id and names no version, so
 * an edit to the version leaves it as true as it was.
 *
 * When there is nothing to compare — no bound in the message, a floating
 * version, a range with no lower bound — the message stays, as it did before this
 * rule existed.
 */
export function wasAboutAnotherVersion(message: string, declared: string): boolean {
  const named = /\((?:>=|>|=)\s*([^\s)]+)/.exec(message)?.[1];
  if (!named || !declared || declared.includes('*')) return false;
  const lower = parseNuGetVersionRange(declared).minVersion;
  return !!lower && !versionsEqual(named, lower);
}

/** {@link unresolvedForProject} for every project of a scope, as one list. Never throws: the list is not worth losing over this. */
export async function unresolvedReferences(
  projectPaths: readonly string[],
  installed: readonly InstalledPackage[],
  deps: UnresolvedDeps = realUnresolvedDeps,
): Promise<InstalledPackage[]> {
  const unique = projectPaths.filter((p, i) => projectPaths.findIndex((o) => pathsEqual(o, p)) === i);
  const perProject = await Promise.all(unique.map(async (projectPath) => {
    try {
      return await unresolvedForProject(projectPath, installed, deps);
    } catch {
      return [];
    }
  }));
  return perProject.flat();
}
