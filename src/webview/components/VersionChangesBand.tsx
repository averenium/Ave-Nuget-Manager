import React from 'react';
import type { VersionDependencyDiff } from '../../packageVersionDiff';
import type { ReleaseNotesLink } from '../../packageLinks';

interface Props {
  diff: VersionDependencyDiff;
  /** The version installed now, and the one the selector is offering. */
  from: string;
  to: string;
  /** The band's own link (#125) — release notes when the package names a bare address for them, the project's releases page otherwise. Absent when neither exists. */
  releaseNotesLink?: ReleaseNotesLink;
  /** A changelog the *installed* (`from`) version ships, absolute path — absent when it ships none of the conventional names (#125). */
  changelogPath?: string;
  onOpenChangelog?: (filePath: string) => void;
}

/**
 * What taking the selected version would change, beside the version number
 * (#114).
 *
 * Both versions' entries come out of the same registration pages, so the
 * difference costs nothing — and it is the one thing an update can be asked
 * about that the toolchain answers nowhere: `--outdated` says a newer version
 * exists and stops, the manifest diff shows a version number, and restore
 * succeeds either way.
 *
 * Under the version row and nowhere else: it describes the *picked* version, and
 * the resolved Dependencies tree below still describes what is installed now.
 * Absent while the picked version is the installed one, because then there is
 * nothing to describe.
 *
 * **The licence is deliberately not a row here.** #89 owns that fact and puts it
 * in Problems, where a consequence belongs; saying it in both places would be
 * two designs for one thing, and Problems is the one also reachable from a row
 * the reader has not opened. It travels in the same answer as this — one
 * question about the same two versions — and is rendered there.
 *
 * The header's right side also carries two links the rows above cannot say
 * (#125): what the release itself claims to have changed, when the publisher
 * names an address for it or failing that a repository whose releases list is
 * reachable; and, separately, the changelog the *installed* version shipped —
 * always stamped with that version, never the one being considered, since the
 * file on disk cannot describe a step it has not taken.
 */
export function VersionChangesBand({
  diff, from, to, releaseNotesLink, changelogPath, onOpenChangelog,
}: Props) {
  return (
    <div className="detail-section">
      <div className="dep-section__header">
        <span className="detail-section__title">What changes</span>
        <span className="dep-section__aside">
          <span className="dep-section__context">{from} → {to}</span>
          {releaseNotesLink && (
            <a
              className="dep-section__link"
              href={releaseNotesLink.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {releaseNotesLink.label}
            </a>
          )}
          {changelogPath && (
            <button
              type="button"
              className="dep-section__link"
              onClick={() => onOpenChangelog?.(changelogPath)}
              title={`Open the changelog ${from} shipped`}
            >
              Changelog ({from})
            </button>
          )}
        </span>
      </div>
      <div className="dep-list">
        {diff.added.map((change) => (
          <div className="chg-row" key={`add:${change.id}`}>
            <span className="chg-row__op chg-row__op--add" aria-hidden="true">+</span>
            <span className="chg-row__id" title={change.id}>{change.id}</span>
            <span className="chg-row__to">{change.to ?? 'any version'} — new dependency</span>
          </div>
        ))}
        {diff.changed.map((change) => (
          <div className="chg-row" key={`chg:${change.id}`}>
            {/* Not an arrow: whether the range went up is a judgement about what
                restore would pick inside it, which this does not make. */}
            <span className="chg-row__op chg-row__op--change" aria-hidden="true">~</span>
            <span className="chg-row__id" title={change.id}>{change.id}</span>
            <span className="chg-row__to">{change.from ?? 'any version'} → {change.to ?? 'any version'}</span>
          </div>
        ))}
        {diff.dropped.map((change) => (
          <div className="chg-row" key={`drop:${change.id}`}>
            <span className="chg-row__op chg-row__op--drop" aria-hidden="true">−</span>
            <span className="chg-row__id chg-row__id--drop" title={change.id}>{change.id}</span>
            <span className="chg-row__to">no longer declared</span>
          </div>
        ))}
        {diff.frameworksDropped.length > 0 && (
          <div className="chg-row">
            <span className="chg-row__op chg-row__op--change" aria-hidden="true">!</span>
            <span className="chg-row__id">Declared frameworks</span>
            {/* Only frameworks this workspace targets reach here: a package
                dropping one nobody builds for is not a consequence. */}
            <span className="chg-row__to">
              stops declaring {diff.frameworksDropped.join(', ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
