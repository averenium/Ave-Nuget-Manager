import React, { useState } from 'react';
import type { BatchLicenseFinding } from '../../packageLicense';
import { LicenseSideText } from './LicenseSideText';

interface Props {
  findings: BatchLicenseFinding[];
  /** The whole batch, so the count says what the button is about to do. */
  totalItems: number;
  /** Package ids the user chose to leave out; the rest of the batch proceeds. */
  onConfirm: (excluded: string[]) => void;
  onCancel: () => void;
}

/**
 * The licence confirmation that stands between "update all" and the first
 * `dotnet add` (#89).
 *
 * A bump can move a package from one licence to another and nothing else in the
 * toolchain says so — restore succeeds, `--outdated` is silent, the manifest
 * diff shows a version number. The Problems row covers the reader who opened the
 * package; nobody opens anything on the way to an "update all", which is the
 * scenario the whole issue is argued from, so it needs a confirmation of its own.
 *
 * Two decisions shape it. There is **one popup for the whole batch**, never one
 * per package. And **rows are deselectable rather than the whole thing being a
 * yes/no**: a plain question gets answered "no", and losing tens of packages to
 * one licence note is worse than the note. Unchecking a row drops that package
 * and lets the rest through.
 *
 * The wording says what the expressions are and never what they mean — not that
 * a change is safe, an improvement, or more permissive. Those are readings of
 * the licences, and this extension is not the thing that should be making them.
 */
export function BatchLicensePopup({ findings, totalItems, onConfirm, onCancel }: Props) {
  // Checked is "keep it in the batch". The user asked for this update; the popup
  // names a reason to reconsider particular packages, not a reason to undo the
  // click by default.
  const [excluded, setExcluded] = useState<string[]>([]);
  const toggle = (packageId: string) => setExcluded((prev) =>
    (prev.includes(packageId) ? prev.filter((id) => id !== packageId) : [...prev, packageId]));

  const going = totalItems - excluded.length;
  const unnamed = findings.filter((f) => f.change.unnamed).length;

  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="batch-licence-title">
      <div className="popup">
        <div className="popup__title" id="batch-licence-title">Licences change in this update</div>
        <div className="popup__body">
          <p>
            {findings.length === 1 ? 'One package' : `${findings.length} packages`} of the{' '}
            {totalItems} in this update {findings.length === 1 ? 'states' : 'state'} a different
            licence at the version {findings.length === 1 ? 'it moves' : 'they move'} to. Uncheck
            any you would rather leave where {findings.length === 1 ? 'it is' : 'they are'} — the
            rest of the update goes ahead.
          </p>
          <ul className="popup__list-plain">
            {findings.map((f) => (
              <li key={f.packageId} className="batch-licence__row">
                <label className="batch-licence__label">
                  <input
                    type="checkbox"
                    checked={!excluded.includes(f.packageId)}
                    onChange={() => toggle(f.packageId)}
                  />
                  <span className="batch-licence__pkg">{f.packageId}</span>
                  {/* Written separators, not only the flex gap: the row is one
                      sentence the reader scans left to right, and a copied row
                      keeps nothing but its text. */}
                  <span className="batch-licence__versions">
                    {f.fromVersion} → {f.toVersion}
                  </span>
                  <span className="batch-licence__sep" aria-hidden="true">·</span>
                  <span
                    className={f.change.unnamed
                      ? 'batch-licence__change batch-licence__change--unnamed'
                      : 'batch-licence__change'}
                  >
                    <LicenseSideText side={f.change.from} />
                    {' → '}
                    <LicenseSideText side={f.change.to} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {unnamed > 0 && (
            <p>
              A licence marked as a file is one this extension cannot name or read — it ships
              inside the package, and only opening it says what it allows.
            </p>
          )}
        </div>
        <div className="popup__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={going === 0}
            onClick={() => onConfirm(excluded)}
          >
            {going === totalItems
              ? `Update all ${totalItems}`
              : `Update ${going} of ${totalItems}`}
          </button>
        </div>
      </div>
    </div>
  );
}
