import React, { useCallback, useEffect, useRef, useState } from 'react';
import { movesOf } from '../../cascadeResult';
import type { CascadeResult } from '../../cascadeResult';
import type { CascadeAction } from '../../messages';
import { panelMovedOn } from '../utils/dependentsRequest';
import { useNugetManager, type CascadeAsk, type CascadeDecision } from '../context/NugetManagerContext';
import { CASCADE_ANSWER_BUDGET_MS, dequeueWrite, dropWrite, queuedCount, releaseWrite } from '../utils/cascadeGate';
import { useBeginCascade } from '../context/useDependentsGate';
import { batchMessageFor, planFor, type CascadePlan } from '../utils/cascadePlan';
import { containerFor, projectLabel, type CascadeButton } from '../utils/cascadeView';
import { BATCH_START_BUDGET_MS, cascadeBatchStatus } from '../utils/cascadeState';
import { packageIdsEqual } from '../../pathCompare';
import { DependentCascadePopup } from './DependentCascadePopup';

/**
 * Mounted once, at the root, for the dependents proposal (#109): it reads the
 * host's answer, puts the popup in front of a held write or opens the page, and
 * carries a decision out — whether it was taken in the popup or on the page.
 * The write runs here, in the panel, where every write runs.
 */
export function DependentCascadeLayer() {
  const { state, dispatch, send } = useNugetManager();
  const ask = state.cascade.current;
  const decision = state.cascade.decision;
  const [reviewing, setReviewing] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  const staleSent = useRef<string | null>(null);
  const openedWith = useRef<{ mark: string; selected: string | null } | null>(null);
  const begin = useBeginCascade();
  const [checking, setChecking] = useState(false);

  // The batch this proposal sent: followed from here, so the person who was on
  // Packages is not taken to Groups and left to guess how it came out (#109).
  const batch = state.cascade.batch;
  const job = batch?.jobId ? state.updates.jobs.find((j) => j.id === batch.jobId) : undefined;
  const batchStatus = batch ? cascadeBatchStatus(batch, job) : null;
  const batchPhase = batchStatus?.phase;
  const batchJob = batch?.jobId;
  useEffect(() => {
    // A success has said what it had to; a failure stays until it is dismissed.
    if (batchPhase !== 'ok') return;
    const timer = setTimeout(() => dispatch({ type: 'CASCADE_BATCH_DONE' }), 12_000);
    return () => clearTimeout(timer);
  }, [batchPhase, batchJob, dispatch]);
  // The host starts a job the moment it takes the batch. One that never starts
  // — everything in it blocked, or another batch already running — must not
  // leave a line saying it is under way.
  const sent = !!batch && !batchJob;
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => dispatch({ type: 'CASCADE_BATCH_DONE' }), BATCH_START_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [sent, dispatch]);

  const end = useCallback((requestId: string) => {
    dropWrite(requestId);
    dispatch({ type: 'CASCADE_END', requestId });
    setReviewing((current) => (current === requestId ? null : current));
  }, [dispatch]);

  /** Runs a plan: the one place a decision turns into a write. */
  const carryOut = useCallback((plan: CascadePlan, requestId: string, request: CascadeAsk['request'], action?: CascadeAction | 'close') => {
    // Switching the offer off is a choice that outlives this write: it is stored,
    // and the panel acts on it at once rather than when the host has said so.
    if (action === 'never-offer') {
      dispatch({ type: 'CASCADE_OFFER', enabled: false });
      send({ type: 'SET_OFFER_DEPENDENT_UPDATES', enabled: false });
    }
    switch (plan.kind) {
      case 'drop':
        break;
      case 'proceed':
        releaseWrite(requestId)?.();
        break;
      case 'batch':
        dispatch({
          type: 'CASCADE_BATCH_SENT',
          batch: {
            packageId: request.packageId,
            toVersion: plan.items.find((i) => packageIdsEqual(i.packageId, request.packageId))?.toVersion ?? request.toVersion,
            project: projectLabel(plan.items[0]?.projects[0] ?? request.projectPath),
          },
        });
        send(batchMessageFor(plan.items, state.packages.prerelease));
        break;
      case 'block':
        send({ type: 'SET_PACKAGE_BLOCKED', packageId: plan.packageId, blocked: true });
        break;
    }
    end(requestId);
  }, [dispatch, end, send, state.packages.prerelease]);

  // The host answered. Nothing to move releases the write; anything else is put
  // in front of the person — a popup, or the page straight away when it was
  // asked for on a row and is too large to read in one.
  useEffect(() => {
    if (!ask?.answered || handled.current === ask.requestId) return;
    handled.current = ask.requestId;
    const result = ask.result;
    const container = result ? containerFor(result, ask.mode) : 'none';

    if (container === 'none') {
      if (ask.mode === 'apply') {
        releaseWrite(ask.requestId)?.();
      } else {
        send({
          type: 'SHOW_TOAST',
          message: result
            ? `Nothing else has to move with ${ask.request.packageId} ${ask.request.toVersion}.`
            : `${ask.request.packageId}: ${ask.unavailable ?? 'the dependents could not be checked'}.`,
        });
      }
      dispatch({ type: 'CASCADE_END', requestId: ask.requestId });
      return;
    }
    if (container === 'page') {
      send({ type: 'CASCADE_OPEN_PAGE', requestId: ask.requestId, waiting: false });
    }
  }, [ask, dispatch, send]);

  // A question the host never answers must not hold a write forever. It goes
  // ahead, and the Log says why — an unknown never blocks a write.
  useEffect(() => {
    if (!ask || ask.answered || ask.mode !== 'apply') return;
    const timer = setTimeout(() => {
      send({
        type: 'WEBVIEW_ACTION',
        action: 'confirm',
        packageId: ask.request.packageId,
        version: ask.request.toVersion,
        detail: [`the dependents check did not answer within ${CASCADE_ANSWER_BUDGET_MS / 1000}s`, 'the update went ahead without it'],
      });
      releaseWrite(ask.requestId)?.();
      dispatch({ type: 'CASCADE_END', requestId: ask.requestId });
    }, CASCADE_ANSWER_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [ask, dispatch, send]);

  // The next write in line starts its question the moment the one in front is
  // settled, so a click made while another was waiting is not lost (#109).
  useEffect(() => {
    if (ask) return;
    const next = dequeueWrite();
    if (!next) return;
    dispatch({ type: 'CASCADE_QUEUE', count: queuedCount() });
    // The offer was switched off while it waited: it goes as it was asked.
    if (!state.cascade.offer || !begin(next.request, 'apply', next.write)) next.write();
  }, [ask, begin, dispatch, state.cascade.offer]);

  // Something has to be on screen while the host reads the feed: the write is
  // held, the button has been pressed, and a pause that long with nothing to
  // show reads as a click that did nothing. Not before a beat has passed — the
  // common answer comes from the restore file alone and needs no announcement.
  const waitingFor = ask && !ask.answered && ask.mode === 'apply' ? ask.requestId : null;
  useEffect(() => {
    setChecking(false);
    if (!waitingFor) return;
    const timer = setTimeout(() => setChecking(true), 300);
    return () => clearTimeout(timer);
  }, [waitingFor]);

  // A decision taken on the page. It carries the moves the person was shown, so
  // it is carried out whether or not the panel still holds the question.
  useEffect(() => {
    if (!decision) return;
    const taken: CascadeDecision = decision;
    dispatch({ type: 'CASCADE_DECISION_TAKEN' });
    const held = ask?.requestId === taken.requestId ? ask : null;
    const plan = planFor({
      action: taken.action,
      mode: held?.mode ?? 'asked',
      packageId: taken.packageId,
      projectPath: taken.projectPath,
      moves: taken.moves,
      confineFramework: held?.request.confineFramework,
    });
    carryOut(plan, taken.requestId, held?.request ?? {
      packageId: taken.packageId, fromVersion: '', toVersion: '', projectPath: taken.projectPath, frameworks: [taken.framework],
    }, taken.action);
  }, [decision, ask, carryOut, dispatch]);

  // The panel moved on from what the open page was computed for: the page keeps
  // its snapshot and says so, rather than re-rendering under the reader.
  const installed = state.packages.installed;
  const selected = state.detail.selectedPackageId;
  useEffect(() => {
    if (!ask?.pageOpen) return;
    // Once per time the host says the page is current: a recompute clears the
    // page's mark, and the panel has to be able to put it back.
    const mark = `${ask.requestId}:${ask.pageEpoch}`;
    // What was selected when the page became current is what it is measured
    // against: a right-click on a row asks about a package without selecting it.
    if (openedWith.current?.mark !== mark) openedWith.current = { mark, selected };
    if (staleSent.current === mark) return;
    if (!panelMovedOn(ask.request, installed, selected, openedWith.current.selected)) return;
    staleSent.current = mark;
    send({ type: 'CASCADE_PAGE_STALE', requestId: ask.requestId });
  }, [ask, installed, selected, send]);

  // The page closed. Nothing more is waiting on it unless a decision follows.
  const pageWasOpen = useRef<string | null>(null);
  useEffect(() => {
    if (ask?.pageOpen) {
      pageWasOpen.current = ask.requestId;
      return;
    }
    if (ask && pageWasOpen.current === ask.requestId) {
      pageWasOpen.current = null;
      setReviewing(null);
      // An asked question has nothing left once its page is closed. A waiting
      // write is cancelled by the host's own decision message.
      if (ask.mode === 'asked') dispatch({ type: 'CASCADE_END', requestId: ask.requestId });
    }
  }, [ask, dispatch]);

  if (!(checking && ask && !ask.answered && ask.mode === 'apply') && batch) {
    return (
      <div className={`cascade-checking cascade-checking--${batchStatus?.phase ?? 'running'}`} role="status">
        <span>{batchStatus?.text}</span>
        <span className="cascade-checking__actions">
          <button type="button" className="dep-section__link" onClick={() => dispatch({ type: 'SET_TAB', tab: 'updates' })}>
            Show in Groups
          </button>
          {batchStatus?.phase !== 'running' && (
            <button type="button" className="dep-section__link" onClick={() => dispatch({ type: 'CASCADE_BATCH_DONE' })}>
              Dismiss
            </button>
          )}
        </span>
      </div>
    );
  }
  if (checking && ask && !ask.answered && ask.mode === 'apply') {
    const waiting = state.cascade.queued;
    return (
      <div className="cascade-checking" role="status">
        <span>
          Checking which packages depend on {ask.request.packageId} {ask.request.toVersion}…
          {waiting > 0 ? ` ${waiting} more ${waiting === 1 ? 'update is' : 'updates are'} waiting.` : ''}
        </span>
        <button type="button" className="dep-section__link" onClick={() => end(ask.requestId)}>
          Cancel the update
        </button>
      </div>
    );
  }
  // A write queued while the first is reviewed on the page would otherwise look
  // like a click that did nothing.
  if (ask?.pageOpen && ask.mode === 'apply' && state.cascade.queued > 0) {
    const waiting = state.cascade.queued;
    return (
      <div className="cascade-checking" role="status">
        <span>
          Waiting for the dependents page. {waiting} more {waiting === 1 ? 'update is' : 'updates are'} queued behind it.
        </span>
      </div>
    );
  }
  if (!ask?.answered || !ask.result) return null;
  const result: CascadeResult = ask.result;
  const container = containerFor(result, ask.mode);
  if (container !== 'popup' || ask.pageOpen || reviewing === ask.requestId) return null;

  const onAction = (action: CascadeButton['action']) => {
    if (action === 'review') {
      setReviewing(ask.requestId);
      send({ type: 'CASCADE_OPEN_PAGE', requestId: ask.requestId, waiting: ask.mode === 'apply' });
      return;
    }
    carryOut(
      planFor({
        action,
        mode: ask.mode,
        packageId: ask.request.packageId,
        projectPath: ask.request.projectPath,
        moves: movesOf(result),
        confineFramework: ask.request.confineFramework,
      }),
      ask.requestId,
      ask.request,
      action,
    );
  };

  return <DependentCascadePopup result={result} mode={ask.mode} onAction={onAction} />;
}
