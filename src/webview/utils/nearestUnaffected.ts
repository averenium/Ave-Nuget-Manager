import type { VersionFlag } from '../../types';

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
  const selectedAt = allVersions.indexOf(selectedVersion);
  if (selectedAt <= 0) return undefined;
  // Walking up from the selected version reaches the smallest step first.
  for (let at = selectedAt - 1; at >= 0; at -= 1) {
    const version = allVersions[at];
    if (!versionFlags[version]?.advisories?.length) return version;
  }
  return undefined;
}
