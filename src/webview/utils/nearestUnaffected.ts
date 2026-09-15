import type { VersionFlag } from '../../types';
import { versionsEqual } from '../../semver';
import { flagsForVersion } from './versionFlags';

/**
 * The nearest version above the selected one that the feed flags no advisory
 * against (#114).
 *
 * Every entry is already in memory — the version walk downloaded the
 * vulnerabilities per version, and the panel keeps them to mark the dropdown —
 * so this costs nothing and turns a warning into something the reader can act
 * on in one click. Nearest rather than newest on purpose: clearing an advisory
 * should cost the smallest move that clears it, not a jump to the head of the
 * list with whatever else that carries.
 *
 * Undefined when nothing above is clean, which is a real answer: it means the
 * feed flags every later version too, and the panel says nothing rather than
 * offering a move that fixes nothing.
 */
export function nearestUnaffectedVersion(
  /** Every version the feed listed, newest first. */
  allVersions: string[],
  versionFlags: Record<string, VersionFlag>,
  selectedVersion: string,
): string | undefined {
  // The picker's list and the version on screen can come from different places
  // and spell the same version differently (`1.0` against `1.0.0`), which an
  // index lookup reads as "not in the list" and answers nothing to.
  const selectedAt = allVersions.findIndex((v) => versionsEqual(v, selectedVersion));
  if (selectedAt <= 0) return undefined;
  // Walking up from the selected version reaches the smallest step first.
  for (let at = selectedAt - 1; at >= 0; at -= 1) {
    const version = allVersions[at];
    if (!flagsForVersion(versionFlags, version)?.advisories?.length) return version;
  }
  return undefined;
}
