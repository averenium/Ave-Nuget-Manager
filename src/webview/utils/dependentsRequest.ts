import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { compareSemVer, versionsEqual } from '../../semver';
import { frameworkKey } from '../../frameworkMoniker';
import type { InstalledPackage } from '../../types';

export interface DependentsRequestInput {
  installed: readonly InstalledPackage[];
  packageId: string;
  projectPath: string;
  toVersion: string;
  /** Every framework the project declares, for a reference that names none. */
  projectFrameworks?: readonly string[];
  /** Set when the write is confined to one framework of the project (#82). */
  onlyFramework?: string;
}

export interface DependentsRequest {
  packageId: string;
  fromVersion: string;
  toVersion: string;
  projectPath: string;
  frameworks: string[];
  confineFramework?: string;
}

/**
 * The dependents question for a write, or `undefined` when there is none to ask
 * (#109): the package is not referenced there yet (nothing built against it can
 * be put out of range by adding it) or the version does not change.
 *
 * `fromVersion` is the lowest the project restored for this reference across
 * its frameworks, the same "stay where you are" the rest of the panel uses; the
 * host reads each framework's own restore when it walks.
 */
export function dependentsRequestFor(input: DependentsRequestInput): DependentsRequest | undefined {
  const entries = input.installed.filter((p) =>
    packageIdsEqual(p.id, input.packageId)
    && pathsEqual(p.projectPath, input.projectPath)
    && (!input.onlyFramework || (!!p.framework && frameworkKey(p.framework) === frameworkKey(input.onlyFramework))));
  if (entries.length === 0 || !input.toVersion) return undefined;

  const fromVersion = entries.map((e) => e.resolvedVersion).sort(compareSemVer)[0];
  if (!fromVersion || versionsEqual(fromVersion, input.toVersion)) return undefined;

  const named = [...new Set(entries.map((e) => e.framework).filter((f): f is string => !!f))];
  const frameworks = input.onlyFramework
    ? [input.onlyFramework]
    : named.length > 0 ? named : [...(input.projectFrameworks ?? [])];

  return {
    packageId: input.packageId,
    fromVersion,
    toVersion: input.toVersion,
    projectPath: input.projectPath,
    frameworks,
    confineFramework: input.onlyFramework,
  };
}

/**
 * Whether the row's right-click menu draws "Check what else has to move" (#109).
 * The registration data the check reads exists only on the HTTP catalog path, so
 * with it off the item is hidden — an entry point that can never do anything is
 * not an entry point.
 */
export function showsCascadeCheck(httpCatalog: boolean, check: DependentsRequest | undefined): boolean {
  return httpCatalog && check !== undefined;
}

/**
 * Whether the panel has moved on from what an open page was computed for
 * (#109): another package is selected, or the reference is no longer where the
 * page left it — a write landed, a refresh changed the version, the package was
 * removed. The page keeps its snapshot and says so rather than re-rendering
 * under the reader.
 */
export function panelMovedOn(
  request: Pick<DependentsRequest, 'packageId' | 'fromVersion' | 'projectPath'>,
  installed: readonly InstalledPackage[],
  selectedPackageId: string | null,
): boolean {
  if (!selectedPackageId || !packageIdsEqual(selectedPackageId, request.packageId)) return true;
  return !installed.some((p) =>
    packageIdsEqual(p.id, request.packageId)
    && pathsEqual(p.projectPath, request.projectPath)
    && versionsEqual(p.resolvedVersion, request.fromVersion));
}
