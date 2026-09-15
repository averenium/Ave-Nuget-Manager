import React from 'react';
import type { VersionDependencyDiff } from '../../packageVersionDiff';

interface Props {
  diff: VersionDependencyDiff;
  /** The version installed now, and the one the selector is offering. */
  from: string;
  to: string;
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
 */
export function VersionChangesBand({ diff, from, to }: Props) {
  return (
    <div className="detail-section">
      <div className="dep-section__header">
        <span className="detail-section__title">What changes</span>
        <span className="dep-section__context">{from} → {to}</span>
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
