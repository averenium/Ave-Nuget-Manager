import type { VersionFlag } from '../../types';
import { versionsEqual } from '../../semver';

/**
 * What the feed said about a version, found however either side spelled it
 * (#114).
 *
 * The record is keyed by the feed's spelling, and the version being asked about
 * usually comes from somewhere else — the restore graph, a project file, the
 * picker. `1.0` and `1.0.0` are one version to NuGet and two keys to an object,
 * so an exact-key lookup answers "nothing known about this version" for a
 * version the feed described in full. That failure is silent in every case this
 * is used for: a missing publication date, an unreported advisory, a withdrawn
 * version nobody is warned about.
 *
 * The fast path is the exact key, because the two spellings usually do agree;
 * the scan only runs when they do not.
 */
export function flagsForVersion(
  flags: Record<string, VersionFlag>,
  version: string | undefined,
): VersionFlag | undefined {
  if (!version) return undefined;
  const exact = flags[version];
  if (exact) return exact;
  const key = Object.keys(flags).find((known) => versionsEqual(known, version));
  return key === undefined ? undefined : flags[key];
}
