import React, { useEffect, useState } from 'react';
import type { CascadeNode, CascadeResult } from '../../cascadeResult';
import type { CascadeAction } from '../../messages';
import {
  actionsFor,
  closureMakeup,
  consequenceLine,
  findNode,
  ladderRows,
  leadFor,
  pairOf,
  parentOf,
  centralBadges,
  inLabel,
  LEFT_OUT_NOTE,
  PROJECT_NOTE,
  movesAgainstRoot,
  projectLabel,
  rowCount,
  UNKNOWN_NOTE,
  VIRTUAL_NOTE,
  whyLine,
} from '../utils/cascadeView';
import { CascadeTree } from './CascadeTree';
import { Lead } from './DependentCascadePopup';
import { NeverOfferMenu } from './NeverOfferMenu';
import { VersionChangesBand } from './VersionChangesBand';

export interface CascadePageSnapshot {
  requestId: string;
  result: CascadeResult;
  waiting: boolean;
  stale: boolean;
}

interface Props {
  snapshot: CascadePageSnapshot;
  onAction: (action: CascadeAction | 'recompute' | 'close') => void;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The page that reviews a closure too large to read in a popup (#109): a tree
 * and a detail pane. The tree is the popup's — the same component and the same
 * row — and the pane carries what a row cannot: why this package has to move,
 * what its move changes, and which version it moves to and why that one.
 *
 * It is a snapshot. It names the package, the target version and the (project,
 * framework) it was computed for, and when the panel moves on it says so
 * rather than re-rendering under the reader. There are no per-row checkboxes: a
 * cascade's members are causally linked, and leaving one out defeats taking the
 * rest. The extra room is for reading.
 */
export function DependentCascadePage({ snapshot, onAction }: Props) {
  const { result, waiting, stale } = snapshot;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A recomputed closure may no longer hold the row that was picked.
  useEffect(() => {
    if (selectedId && !findNode(result, selectedId)) setSelectedId(null);
  }, [result, selectedId]);

  const selected = findNode(result, selectedId);
  const buttons = actionsFor(result, waiting ? 'apply' : 'asked').filter((b) => b.action !== 'review');
  const decisive = buttons.filter((b) => b.primary);
  const dismiss = buttons.filter((b) => !b.primary);

  const count = rowCount(result);
  const badges = centralBadges(result);

  return (
    <div className={`cascade-page${stale ? ' cascade-page--stale' : ''}`}>
      <header className="cascade-page__head">
        <div className="cascade-page__titlerow">
          <div className="cascade-page__title">
            <span className="cascade-page__name" title={result.packageId}>{result.packageId}</span>
            <PairText from={result.fromVersion} to={result.toVersion} />
          </div>
          {waiting && (
            <div className="cascade-page__actions">
              <NeverOfferMenu onChoose={() => onAction('never-offer')} />
            </div>
          )}
        </div>
        <div className="cascade-page__ctx">
          {badges ? (
            // One version, set centrally, governs every project beneath the file:
            // the page's identity is the file and its projects, and no one framework.
            <>
              <span className="badge" title={result.central?.propsFile}>{badges.file}</span>
              {badges.shown.map((name, i) => (
                <span className="badge" key={`${name}-${i}`} title={result.central?.projects[i]}>{name}</span>
              ))}
              {badges.more > 0 && <span className="badge" title={badges.all.join(', ')}>+{badges.more} more</span>}
            </>
          ) : (
            <>
              <span className="badge" title={result.projectPath}>{projectLabel(result.projectPath)}</span>
              <span className="badge">{result.framework}</span>
            </>
          )}
          {!badges && result.otherFrameworks && result.otherFrameworks.length > 0 && (
            <span className="cascade-page__waiting">
              The answer differs for {result.otherFrameworks.join(', ')}.
            </span>
          )}
        </div>
        {waiting && (
          <div className="dep-section__note" style={{ margin: '2px 0 0' }}>
            <strong>An update is waiting on this.</strong> Nothing has been written; closing this page cancels it.
          </div>
        )}
        <p className="cascade-page__lead"><Lead segments={leadFor(result, 'asked', 'page')} /></p>
      </header>

      {stale && (
        <div className="cascade-page__notice">
          <div className="sources-warn sources-warn--stale" role="status">
            The panel has moved on. This closure was computed for {result.packageId} {result.fromVersion} → {result.toVersion} in{' '}
            {badges
              ? `${badges.file}, used by ${badges.all.length} projects`
              : `${projectLabel(result.projectPath)} (${result.framework})`} and may no longer match it.
          </div>
        </div>
      )}

      <div className={`cascade-page__body${selected ? ' cascade-page__body--picked' : ''}`}>
        <div className="cascade-page__tree">
          <div className="cascade-page__cap">
            <span>Have to move</span>
            <span className="cascade-page__cap-count">{count} {plural(count, 'package', 'packages')}</span>
            <span className="sp" />
            {badges && <span className="col">In</span>}
            <span className="col">Range</span>
            <span className="col">Moves</span>
          </div>
          <CascadeTree
            rows={result.root.children}
            against={movesAgainstRoot(result)}
            inOf={badges ? (node) => inLabel(node, result) : undefined}
            bleed
            selectedId={selectedId}
            onSelect={(node) => setSelectedId(node.id === selectedId ? null : node.id)}
          />
        </div>
        <div className="cascade-page__pane">
          {selected
            ? <NodePane result={result} node={selected} onBack={() => setSelectedId(null)} />
            : <ClosurePane result={result} />}
        </div>
      </div>

      <div className="cascade-page__bar">
        <span className="cascade-page__sum">{consequenceLine(result, stale)}</span>
        {dismiss.map((b) => (
          <button key={b.label} type="button" className="btn btn--secondary" onClick={() => onAction(b.action as CascadeAction | 'close')}>
            {b.label}
          </button>
        ))}
        {stale && (
          <button type="button" className="btn btn--primary" onClick={() => onAction('recompute')}>Recompute</button>
        )}
        {decisive.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`btn ${stale ? 'btn--secondary' : 'btn--primary'}`}
            // What depends on the closure waits for a recompute; the block, and a
            // write of the bump alone, do not.
            disabled={stale && (b.action === 'take-all' || (b.action === 'update-anyway' && result.moves > 0))}
            onClick={() => onAction(b.action as CascadeAction)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PairText({ from, to }: { from: string; to: string }) {
  const tone = pairOf({ id: '', installedVersion: from, proposedVersion: to, status: 'moves', children: [] }).tone;
  return <span className={`popup__ver popup__ver--${tone}`}>{from} → {to}</span>;
}

/** The pane before anything is picked: the makeup of the closure, so the first frame already says what kind of set this is. */
function ClosurePane({ result }: { result: CascadeResult }) {
  const makeup = closureMakeup(result);
  return (
    <div className="cascade-pane">
      <div className="cascade-pane__top">
        <div className="cascade-pane__title"><span className="cascade-pane__name">This closure</span></div>
      </div>
      <p className="cascade-pane__why">
        <strong>{makeup.total}</strong> {plural(makeup.total, 'package has', 'packages have')} to move with{' '}
        <code>{result.packageId}</code> <strong>{result.toVersion}</strong>.
      </p>
      <dl className="cascade-kvs">
        <dt>Reached</dt>
        <dd>{makeup.direct} depend on it directly · {makeup.indirect} only through another package in the list</dd>
        <dt>Major lines</dt>
        <dd>{makeup.crossMajor} cross a major version · {makeup.sameLine} stay inside theirs</dd>
        {makeup.sources.length > 0 && (
          <>
            <dt>Sources</dt>
            <dd>{makeup.sources.map((s) => `${s.count} from ${s.name}`).join(' · ')}</dd>
          </>
        )}
        {makeup.unknown > 0 && (
          <>
            <dt>Not judged</dt>
            <dd>{makeup.unknown} could not be established — they stay in the list, dimmed.</dd>
          </>
        )}
        {makeup.implied > 0 && (
          <>
            <dt>Moves with</dt>
            <dd>{makeup.implied} not referenced directly — nothing is written for them. They stay in the list, dimmed.</dd>
          </>
        )}
        {makeup.leftOut > 0 && (
          <>
            <dt>Left out</dt>
            <dd>{makeup.leftOut} judged and not proposed — blocked, or not a direct reference. They stay in the list, dimmed.</dd>
          </>
        )}
      </dl>
      <p className="cascade-pane__hint">Select a package to see why it has to move, what its move changes, and why that version.</p>
    </div>
  );
}

function NodePane({ result, node, onBack }: { result: CascadeResult; node: CascadeNode; onBack: () => void }) {
  const parent = parentOf(result, node);
  const pair = pairOf(node);
  const { rows, older, newer } = ladderRows(node, parent?.proposedVersion);
  const forward = node.direction === 'forward';
  const leftOut = node.status === 'left-out';
  const virtual = node.virtual === true;
  const unknown = node.status === 'unknown' || leftOut || virtual;

  return (
    <div className="cascade-pane">
      <div className="cascade-pane__top">
        <div className="cascade-pane__title">
          <span className="cascade-pane__name" title={node.id}>{node.id}</span>
          {!node.project && <span className={`popup__ver popup__ver--${pair.tone}`}>{pair.from} → {pair.to}</span>}
        </div>
        <button type="button" className="dep-section__link cascade-pane__back" onClick={onBack}>‹ This closure</button>
      </div>
      {node.sourceName && <div className="dep-section__context" style={{ marginTop: -8 }}>{node.sourceName}</div>}
      {unknown ? (
        <div className="detail-section">
          <div className="dep-section__header">
            <span className="detail-section__title">{virtual ? 'Moves with the packages above' : leftOut ? 'Left out' : 'Could not establish'}</span>
          </div>
          <p className="cascade-pane__why"><Lead segments={whyLine(node, parent)} /></p>
          <p className="cascade-pane__why cascade-pane__why--dim">{virtual ? VIRTUAL_NOTE : leftOut ? LEFT_OUT_NOTE : node.project ? PROJECT_NOTE : UNKNOWN_NOTE}</p>
        </div>
      ) : (
        <p className="cascade-pane__why"><Lead segments={whyLine(node, parent)} /></p>
      )}

      {!unknown && <div className="cascade-pane__cols">
        <div className="cascade-pane__col">
          {!unknown && node.proposedVersion && (
            <VersionChangesBand
              title="What changes"
              diff={node.diff}
              from={node.installedVersion}
              to={node.proposedVersion}
              releaseNotesLink={node.releaseNotes}
            />
          )}
          {node.alsoDeclared && node.alsoDeclared.length > 0 && (
            <div className="detail-section">
              <div className="dep-section__header">
                <span className="detail-section__title">Also declared against</span>
              </div>
              <div className="dep-section__note" style={{ margin: 0 }}>
                The list shows it once, under {node.parentId}. It also declares:
              </div>
              <div className="dep-list">
                {node.alsoDeclared.map((edge) => (
                  <div className="chg-row" key={edge.id}>
                    <span className="chg-row__id" title={edge.id}>{edge.id}</span>
                    <span className="chg-row__to">{edge.range}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="cascade-pane__col">
          {rows.length > 0 && parent && (
            <div className="detail-section">
              <div className="dep-section__header">
                <span className="detail-section__title">Which version</span>
                {!unknown && (
                  <span className="dep-section__context">
                    {forward
                      ? `closest to ${node.installedVersion} that satisfies ${(node.requirements ?? []).map((r) => r.range).join(' and ')}`
                      : `closest to ${node.installedVersion} that admits ${parent.proposedVersion}`}
                  </span>
                )}
              </div>
              {forward ? (
                <div className="dep-section__note" style={{ margin: 0 }}>
                  {(node.requirements?.length ?? 0) > 1 ? 'Requirements' : 'One requirement'}, for every version of <b>{node.id}</b>:{' '}
                  {(node.requirements ?? []).map((r, i) => (
                    <React.Fragment key={`${r.id}-${i}`}>{i > 0 && ', '}<code>{r.range}</code></React.Fragment>
                  ))}
                  . The green bar marks the ones that satisfy {(node.requirements?.length ?? 0) > 1 ? 'all of them' : 'it'}.
                </div>
              ) : (
                <div className="dep-section__note" style={{ margin: 0 }}>
                  What each version of <b>{node.id}</b> declares for <code>{parent.id}</code>. The green bar marks the
                  ones that admit <b>{parent.proposedVersion}</b>.
                </div>
              )}
              <div className="cascade-ladder">
                {older > 0 && <div className="cascade-ladder__more">… {older} older</div>}
                {rows.map((row) => (
                  <div
                    key={row.version}
                    className={`cascade-ladder__row${row.admits ? ' cascade-ladder__row--admits' : ''}${row.proposed ? ' cascade-ladder__row--proposed' : ''}`}
                  >
                    <span className="cascade-ladder__v">{row.version}</span>
                    <span className="cascade-ladder__range">{row.range}</span>
                    <span className="cascade-ladder__tag">{row.tag}</span>
                  </div>
                ))}
                {newer > 0 && <div className="cascade-ladder__more">… {newer} newer</div>}
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}
