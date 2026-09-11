import React from 'react';

interface Props {
  packageId: string;
  /** Frameworks whose pin sits in another major line than `toVersion`. */
  frameworks: Array<{ framework: string; version: string }>;
  toVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The major line a version belongs to, for the sentence below. */
function lineOf(version: string): string {
  const m = /^(\d+)/.exec(version.trim());
  return m ? `${m[1]}.x` : version;
}

/**
 * Confirmation for a version change that leaves the major line a framework is
 * pinned to (#82).
 *
 * Batch updates never ask, because they never cross: **All** and a family
 * target stay inside each framework's own line, which is the whole point of
 * reading the pin. A change aimed at one package is different — the pin may be
 * there for framework compatibility, or it may be an accident of history, and
 * only the person looking at it knows which. So the version is offered, the
 * consequence is stated, and the decision stays with them.
 */
export function CrossLinePopup({ packageId, frameworks, toVersion, onConfirm, onCancel }: Props) {
  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="cross-line-title">
      <div className="popup popup--narrow">
        <div className="popup__title" id="cross-line-title">{packageId}</div>
        <div className="popup__body">
          <p>
            <strong>{toVersion}</strong> is in the {lineOf(toVersion)} line.
            {' '}
            {frameworks.length === 1 ? 'This framework is' : 'These frameworks are'} pinned to another:
          </p>
          <ul className="popup__list-plain">
            {frameworks.map(({ framework, version }) => (
              <li key={framework}>
                <span className="pkg-row__tfm">{framework}</span>
                {' '}
                {version} — {lineOf(version)}
              </li>
            ))}
          </ul>
          <p>
            A per-framework pin usually exists because the newer line does not
            support that framework. If this one is only history, taking it across
            is fine — the restore that follows will say if it is not.
          </p>
        </div>
        <div className="popup__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>Update anyway</button>
        </div>
      </div>
    </div>
  );
}
