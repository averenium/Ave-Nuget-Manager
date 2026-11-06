import React, { useEffect } from 'react';
import type { CascadeMode, CascadeResult } from '../../cascadeResult';
import { CASCADE_POPUP_ROWS } from '../../cascadeResult';
import {
  actionsFor,
  deadEndAdvice,
  deadEndLines,
  leadFor,
  movesAgainstRoot,
  overrideNote,
  offersPage,
  previewOf,
  unknownGroups,
  type CascadeButton,
  type Segment,
} from '../utils/cascadeView';
import { CascadeTree } from './CascadeTree';
import { NeverOfferMenu } from './NeverOfferMenu';

interface Props {
  result: CascadeResult;
  mode: CascadeMode;
  onAction: (action: CascadeButton['action']) => void;
}

/** Rows of the tree a popup past the threshold shows before the count takes over. */
const PREVIEW_ROWS = 3;

export function Lead({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) => {
        if (s.code) return <code key={i}>{s.text}</code>;
        if (s.strong) return <strong key={i}>{s.text}</strong>;
        return <React.Fragment key={i}>{s.text}</React.Fragment>;
      })}
    </>
  );
}

/**
 * The confirmation the dependents proposal asks for (#109): which other
 * installed packages have to move with a bump, as one nested tree — a plain,
 * non-checkable list, because a cascade's members are causally linked and
 * leaving one out defeats the point of taking the rest. One decisive action.
 *
 * A dead end offers the pin, not an error. A dependent that could not be judged
 * stays in the tree, dimmed. When every dependent is unknown there is no tree at
 * all: nothing was checked, so nothing is drawn, and nothing can be called
 * unsafe.
 */
export function DependentCascadePopup({ result, mode, onAction }: Props) {
  const buttons = actionsFor(result, mode);
  const dismiss = buttons[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAction(dismiss.action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss.action, onAction]);

  const lead = <p><Lead segments={leadFor(result, mode)} /></p>;
  // A multi-targeted project is answered for the first framework that has
  // something to move; the others are named rather than silently left out.
  const differs = result.otherFrameworks && result.otherFrameworks.length > 0
    ? <p className="cascade-more">Computed for {result.framework}; the answer differs for {result.otherFrameworks.join(', ')}.</p>
    : null;
  const large = offersPage(result, mode);
  const preview = large ? previewOf(result, Math.min(PREVIEW_ROWS, CASCADE_POPUP_ROWS)) : undefined;

  let body: React.ReactNode;
  if (result.outcome === 'dead-end') {
    const lines = deadEndLines(result);
    body = (
      <>
        {lead}
        {lines.length > 0 && (
          <ul className="popup__list-plain">
            {lines.map((line, i) => <li key={i}><Lead segments={line} /></li>)}
          </ul>
        )}
        {overrideNote(result).length > 0 && <p><Lead segments={overrideNote(result)} /></p>}
        <p>{deadEndAdvice()}</p>
        {differs}
      </>
    );
  } else if (result.outcome === 'unknown') {
    body = (
      <>
        {lead}
        <ul className="popup__list-plain">
          {unknownGroups(result).map((group) => (
            <li key={group.label}>
              <strong>{group.label}</strong>
              {' — '}
              <span className="cascade-row__why">{group.ids.join(', ')}</span>
            </li>
          ))}
        </ul>
        {differs}
      </>
    );
  } else {
    body = (
      <>
        {lead}
        <CascadeTree rows={[preview ? preview.root : result.root]} rootId={result.root.id} against={movesAgainstRoot(result)} />
        {preview && preview.hidden > 0 && <div className="cascade-more">and {preview.hidden} more</div>}
        {differs}
      </>
    );
  }

  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="cascade-popup-title">
      <div className="popup">
        {mode === 'apply' ? (
          // Offered on every popup that interrupted a write, in every state, and
          // on none that was asked for on a row, where nothing was offered.
          <div className="popup__head">
            <div className="popup__title" id="cascade-popup-title">{result.packageId}</div>
            <NeverOfferMenu onChoose={() => onAction('never-offer')} />
          </div>
        ) : (
          <div className="popup__title" id="cascade-popup-title">{result.packageId}</div>
        )}
        <div className="popup__body">{body}</div>
        <div className="popup__actions popup__actions--wrap">
          {buttons.map((b) => (
            <button
              key={b.label}
              type="button"
              className={`btn ${b.primary ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => onAction(b.action)}
              autoFocus={b.primary}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
