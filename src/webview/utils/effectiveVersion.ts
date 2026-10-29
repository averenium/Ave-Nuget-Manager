import { highestCompatibleVersion, stayingVersion } from '../../frameworkCompatibility';
import type { DeclaredDependencyGroup } from '../../types';

/**
 * The version the package selector shows (#130, #132): the reader's pick, else
 * the newest the project's frameworks can take, else where the package already
 * is, else the feed's raw newest.
 *
 * One function because two things must agree on it — what the panel describes
 * and what the version-diff question is asked about. The question once used a
 * shorter expression of its own, so a package on its newest compatible version
 * while the feed held a newer one the project could not take was asked about
 * the newer one, and the answer was thrown away as being about a version no
 * longer on screen.
 */
export function effectiveVersionFor(input: {
  selectedVersion: string;
  allVersions: readonly string[];
  declaredGroups: (version: string) => readonly DeclaredDependencyGroup[] | undefined;
  projectTfms: readonly string[];
  installedVersions: readonly string[];
  metadataVersion?: string;
}): string {
  return input.selectedVersion
    || highestCompatibleVersion(input.allVersions, input.declaredGroups, input.projectTfms)
    || stayingVersion(input.installedVersions)
    || input.allVersions[0]
    || input.metadataVersion
    || '';
}
