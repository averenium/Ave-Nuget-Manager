import type { VersionDependencyDiff } from '../../packageVersionDiff';

export interface VersionBand {
  /** Present only when something changes; the band is the header row alone otherwise. */
  diff?: VersionDependencyDiff;
  /** The installed version, when there is one to compare from. */
  from?: string;
  title: string;
}

/**
 * Whether the band under the version row renders, and as what (#132).
 *
 * The dependency difference only exists for an installed package with a known
 * installed version, and only when something differs. The release-notes link
 * and the changelog button are not differences, so either of them is reason
 * enough on its own for the band to exist: the header row alone, titled with
 * the version it is about instead of "What changes".
 *
 * `installedFrom` is the version the panel says the package is on, which counts
 * a transitive package too; `isInstalled` is direct-only. The dependency
 * difference stays direct-only, as before, but the changelog is stamped with
 * `installedFrom` — the host finds it for a transitive package as well — and a
 * changelog with no version to stamp it with is not shown, nor counted as a
 * reason for the band to exist, so the band is never a heading with nothing in it.
 */
export function versionBandFor(input: {
  diff: VersionDependencyDiff | undefined;
  isInstalled: boolean;
  installedFrom: string;
  to: string;
  hasReleaseNotesLink: boolean;
  hasChangelog: boolean;
}): VersionBand | undefined {
  const diff = input.isInstalled && input.installedFrom ? input.diff : undefined;
  const hasChangelog = input.hasChangelog && !!input.installedFrom;
  if (!diff && !input.hasReleaseNotesLink && !hasChangelog) return undefined;
  return {
    diff,
    from: input.installedFrom || undefined,
    title: diff ? 'What changes' : `Version ${input.to}`,
  };
}
