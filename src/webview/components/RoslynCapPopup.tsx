import React from 'react';
import type { RoslynCap } from '../../roslynSdkCap';

interface Props {
  packageId: string;
  fromVersion: string;
  toVersion: string;
  cap: RoslynCap;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RoslynCapPopup({
  packageId, fromVersion, toVersion, cap, onConfirm, onCancel,
}: Props) {
  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="roslyn-cap-title">
      <div className="popup popup--narrow">
        <div className="popup__title" id="roslyn-cap-title">{packageId}</div>
        <div className="popup__body">
          <p>
            <span className="popup__ver popup__ver--up">{fromVersion} → {toVersion}</span>
          </p>
          <p>
            Active SDK <strong>{cap.sdkVersion}</strong>
            {' · '}
            bundled compiler <strong>{cap.compilerVersion}</strong>
          </p>
          <p>
            The team needs to update the .NET SDK before this package version
            (it is newer than the compiler in the current SDK). Analyzers / source
            generators may fail to load if you continue.
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
