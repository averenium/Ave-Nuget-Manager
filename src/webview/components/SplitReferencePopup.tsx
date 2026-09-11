import React from 'react';

interface Props {
  packageId: string;
  /** One entry per project whose single reference has to become several. */
  projects: Array<{ name: string; frameworks: string[] }>;
  version: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for a narrowing that has to split a shared reference (#82).
 *
 * Leaving a framework out of an install is only meaningful if the project
 * states that framework's version on its own. When the project states one
 * unconditional `PackageReference` for all of them, `dotnet add --framework`
 * cannot narrow it — it edits that one line and moves every framework with it —
 * so the reference is rebuilt as one conditional group per framework. Nothing
 * about the versions changes for the frameworks left out, but the shape of the
 * project file does, and that is the user's to agree to.
 *
 * Projects whose frameworks already disagree about the version never get here:
 * their groups exist, and the write goes straight into the matching one.
 */
export function SplitReferencePopup({ packageId, projects, version, onConfirm, onCancel }: Props) {
  const many = projects.length > 1;
  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="split-ref-title">
      <div className="popup popup--narrow">
        <div className="popup__title" id="split-ref-title">{packageId}</div>
        <div className="popup__body">
          <p>
            {many ? 'These projects reference' : 'This project references'} {packageId} once,
            for every target framework at once, so giving {version} to only the frameworks
            you left on {many ? 'splits those references' : 'splits that reference'} into one
            group per framework. Taking {version}:
          </p>
          <ul className="popup__list-plain">
            {projects.map(({ name, frameworks }) => (
              <li key={name}>
                {name} —{' '}
                {frameworks.map((framework) => (
                  <span key={framework} className="pkg-row__tfm">{framework}</span>
                ))}
              </li>
            ))}
          </ul>
          <p>
            The frameworks left out keep the version they have now. Only the shape of
            the project file changes, and it is the shape a per-framework version needs.
          </p>
        </div>
        <div className="popup__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            Split and install
          </button>
        </div>
      </div>
    </div>
  );
}
