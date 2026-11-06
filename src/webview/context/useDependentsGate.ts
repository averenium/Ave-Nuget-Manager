import { useCallback } from 'react';
import { searchableConfigFiles } from '../../searchConfigFiles';
import { enqueueWrite, hasHeldWrite, holdWrite, nextCascadeId, queuedCount } from '../utils/cascadeGate';
import { gateDecision } from '../utils/cascadeState';
import type { CascadeMode } from '../../cascadeResult';
import { useNugetManager, type CascadeAsk } from './NugetManagerContext';

export type DependentsRequest = CascadeAsk['request'];

/**
 * Sends the dependents question to the host and puts it on screen (#109). The
 * one place a question begins, whether it comes from a write that is waiting, a
 * row asked about, or the queue behind a question that has just been settled.
 *
 * `undefined` when there is no feed to read the dependents from.
 */
export function useBeginCascade(): (request: DependentsRequest, mode: CascadeMode, write?: () => void) => boolean {
  const { state, dispatch, send } = useNugetManager();
  const prerelease = state.packages.prerelease;
  const configChain = state.sources.configChain;

  return useCallback((request, mode, write) => {
    const configFiles = searchableConfigFiles(configChain);
    if (configFiles.length === 0 || !request.projectPath) return false;
    const requestId = nextCascadeId(mode);
    if (write) holdWrite(requestId, write);
    dispatch({
      type: 'CASCADE_ASK',
      ask: { requestId, mode, request, answered: false, result: null, pageOpen: false, pageEpoch: 0 },
    });
    send({
      type: 'CHECK_DEPENDENTS',
      requestId,
      packageId: request.packageId,
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      projectPath: request.projectPath,
      frameworks: request.frameworks,
      mode,
      prerelease,
      configFiles,
    });
    return true;
  }, [configChain, prerelease, dispatch, send]);
}

/**
 * Puts the dependents question in front of a write (#109).
 *
 * `gate(request, write)` runs `write` straight away when the question is not
 * one this build can ask — the experimental HTTP catalog is off, or there is no
 * feed to read — and otherwise holds it until the host answers. The layer
 * mounted once at the root decides what the answer means: nothing to move
 * releases the write; something to move puts a popup in front of it.
 *
 * A write that arrives while another is still waiting for its answer is queued
 * behind it, not put in its place: the person who clicked update on a second
 * project before the first had answered meant both, and replacing the first
 * would drop it without a word. The layer starts the next one the moment the
 * one in front is settled.
 */
export function useDependentsGate(): (request: DependentsRequest, write: () => void) => void {
  const { state, dispatch, send } = useNugetManager();
  const begin = useBeginCascade();
  const { httpCatalog, offer, current } = state.cascade;

  return useCallback((request, write) => {
    const decision = gateDecision(httpCatalog, offer, current, !!current && hasHeldWrite(current.requestId));
    if (decision === 'write') {
      // Say so when it is the person's setting that let the write skip the check,
      // the way the Log says when one went ahead after waiting for an answer.
      if (httpCatalog && !offer) {
        send({
          type: 'WEBVIEW_ACTION',
          action: 'confirm',
          packageId: request.packageId,
          version: request.toVersion,
          detail: ['the dependents check is switched off (averenium.nugetManager.offerDependentUpdates)', 'the update went ahead without it'],
        });
      }
      write();
    } else if (decision === 'queue') {
      enqueueWrite({ request, write });
      dispatch({ type: 'CASCADE_QUEUE', count: queuedCount() });
    } else if (!begin(request, 'apply', write)) {
      write();
    }
  }, [httpCatalog, offer, current, begin, dispatch, send]);
}

/** Asks about a row: nothing is waiting, so the answer is shown, not gated on. */
export function useAskDependents(): (request: DependentsRequest) => void {
  const { state, send } = useNugetManager();
  const begin = useBeginCascade();
  const current = state.cascade.current;

  return useCallback((request) => {
    // A write is waiting on the question in front of this one; putting another
    // in its place would drop it without a word.
    if (current && current.mode === 'apply' && hasHeldWrite(current.requestId)) {
      send({ type: 'SHOW_TOAST', message: 'An update is still waiting for its dependents check. Ask again once it has finished.' });
      return;
    }
    if (!begin(request, 'asked')) {
      send({ type: 'SHOW_TOAST', message: 'There is no package source configured to read the dependents from.' });
    }
  }, [begin, current, send]);
}
