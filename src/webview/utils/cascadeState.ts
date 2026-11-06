import type { CascadeMode, CascadeResult } from '../../cascadeResult';
import type { ExtensionMessage } from '../../messages';
import type { BatchItemStatus } from '../../types';

/**
 * A dependents question in flight or on screen (#109). One at a time: the
 * popup is modal and the page is one page, so a second question replaces the
 * first.
 */
export interface CascadeAsk {
  requestId: string;
  /** `apply`: a write is held for the answer. `asked`: the person asked on a row. */
  mode: CascadeMode;
  request: {
    packageId: string;
    fromVersion: string;
    toVersion: string;
    projectPath: string;
    frameworks: string[];
    /** The framework the write is confined to, for a reference pinned per framework (#82). */
    confineFramework?: string;
  };
  answered: boolean;
  result: CascadeResult | null;
  unavailable?: string;
  /** The page is open on this question. */
  pageOpen: boolean;
  /**
   * Counts every time the host says the page is open on this question — on
   * opening and again after each recompute. A recompute clears the page's stale
   * mark, so the panel has to be able to tell it again; one mark per question
   * would leave a page that was recomputed while the panel stood elsewhere
   * looking current.
   */
  pageEpoch: number;
}

export type CascadeDecision = Extract<ExtensionMessage, { type: 'CASCADE_DECISION' }>;

/**
 * The batch a decision on the proposal sent (#109). It is the person's own
 * action on the Packages tab, so it neither takes them to Groups nor ends
 * unannounced: the panel follows it and says how it came out.
 */
export interface CascadeBatch {
  packageId: string;
  toVersion: string;
  /** The project's name, as the page shows it. */
  project: string;
  /** Known once the host starts the job; until then the batch is only sent. */
  jobId?: string;
}

export interface CascadeSlice {
  /**
   * The experimental setting: the registration data the proposal reads exists
   * only on that path, so without it nothing is offered at all.
   */
  httpCatalog: boolean;
  /**
   * `offerDependentUpdates`: the check before a write. Off, a write goes as it
   * was asked; the right-click question is unaffected (#109).
   */
  offer: boolean;
  current: CascadeAsk | null;
  /** A decision taken on the page, waiting for the layer to carry it out. */
  decision: CascadeDecision | null;
  /** Writes waiting behind the question in front of them, for the status line. */
  queued: number;
  /** The batch this proposal sent, until the person has seen how it ended. */
  batch: CascadeBatch | null;
}

export const INITIAL_CASCADE: CascadeSlice = { httpCatalog: false, offer: true, current: null, decision: null, queued: 0, batch: null };

export type CascadeEvent =
  | { kind: 'init'; httpCatalog: boolean; offer?: boolean }
  | { kind: 'http'; enabled: boolean }
  | { kind: 'offer'; enabled: boolean }
  | { kind: 'ask'; ask: CascadeAsk }
  | { kind: 'end'; requestId: string }
  | { kind: 'answer'; requestId: string; result: CascadeResult | null; unavailable?: string }
  | { kind: 'page'; requestId: string; open: boolean; fromVersion?: string }
  | { kind: 'queue'; count: number }
  | { kind: 'decision'; decision: CascadeDecision }
  | { kind: 'decision-taken' }
  | { kind: 'batch-sent'; batch: CascadeBatch }
  | { kind: 'batch-started'; jobId: string }
  /** The host refused to start it, or the person has read the result. */
  | { kind: 'batch-done' };

/**
 * The dependents slice of the panel's state (#109). Answers are matched against
 * the question still waiting: one to a question the person has already moved
 * past must not open a popup over the one in front of them.
 */
export function reduceCascade(slice: CascadeSlice, event: CascadeEvent): CascadeSlice {
  const current = slice.current;
  switch (event.kind) {
    case 'init':
      return { ...slice, httpCatalog: event.httpCatalog, offer: event.offer !== false };
    case 'http':
      return { ...slice, httpCatalog: event.enabled };
    case 'offer':
      return { ...slice, offer: event.enabled };
    case 'ask':
      return { ...slice, current: event.ask };
    case 'end':
      return current?.requestId === event.requestId ? { ...slice, current: null } : slice;
    case 'answer':
      if (!current || current.requestId !== event.requestId) return slice;
      return { ...slice, current: { ...current, answered: true, result: event.result, unavailable: event.unavailable } };
    case 'page':
      if (!current || current.requestId !== event.requestId) return slice;
      return {
        ...slice,
        current: {
          ...current,
          pageOpen: event.open,
          pageEpoch: current.pageEpoch + (event.open ? 1 : 0),
          request: event.fromVersion ? { ...current.request, fromVersion: event.fromVersion } : current.request,
        },
      };
    case 'queue':
      return { ...slice, queued: event.count };
    case 'decision':
      return { ...slice, decision: event.decision };
    case 'decision-taken':
      return { ...slice, decision: null };
    case 'batch-sent':
      return { ...slice, batch: event.batch };
    case 'batch-started':
      return slice.batch && !slice.batch.jobId ? { ...slice, batch: { ...slice.batch, jobId: event.jobId } } : slice;
    case 'batch-done':
      return slice.batch ? { ...slice, batch: null } : slice;
  }
}

/** Whether a job the host has just started is the one this proposal sent — the first to start after it was sent. */
export function startsOurBatch(slice: CascadeSlice): boolean {
  return !!slice.batch && !slice.batch.jobId;
}

/** How long a sent batch may go without the host starting a job for it before the panel stops saying it is under way. */
export const BATCH_START_BUDGET_MS = 10_000;

export interface CascadeBatchStatus {
  phase: 'running' | 'ok' | 'failed' | 'stopped';
  text: string;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What the status line says about the batch: how far it has got while it runs,
 * and how it ended once it has — the one thing the Groups tab never told the
 * person who stayed on Packages.
 */
export function cascadeBatchStatus(
  batch: CascadeBatch,
  job: { items: Array<{ status: BatchItemStatus }>; finishedAt?: number } | undefined,
): CascadeBatchStatus {
  const total = job?.items.length ?? 0;
  const dependents = Math.max(0, total - 1);
  const subject = job && dependents > 0
    ? `${batch.packageId} ${batch.toVersion} and ${dependents} ${plural(dependents, 'package', 'packages')} that had to move with it`
    : `${batch.packageId} ${batch.toVersion}`;

  const count = (...statuses: BatchItemStatus[]) => job?.items.filter((i) => statuses.includes(i.status)).length ?? 0;
  const ok = count('ok');
  const failed = count('error', 'timeout');
  const stopped = count('cancelled');

  if (!job || !job.finishedAt) {
    const done = ok + failed + stopped;
    return {
      phase: 'running',
      text: job
        ? `Updating ${subject} in ${batch.project}… ${done} of ${total} done.`
        : `Updating ${batch.packageId} ${batch.toVersion} and what has to move with it in ${batch.project}…`,
    };
  }
  if (failed > 0) {
    return {
      phase: 'failed',
      text: `${failed} of ${total} ${plural(total, 'update', 'updates')} did not go through in ${batch.project}; ${ok} did. The reason is in the error banner.`,
    };
  }
  if (stopped > 0) {
    return { phase: 'stopped', text: `Stopped. ${ok} of ${total} ${plural(total, 'update was', 'updates were')} made in ${batch.project}.` };
  }
  return { phase: 'ok', text: `Updated ${subject} in ${batch.project}.` };
}

/**
 * What a write that wants the dependents question does (#109).
 *
 * - `write`: the question cannot be asked in this build, or the person has
 *   switched the offer off; the write goes ahead.
 * - `queue`: another write is held for its answer — or its review on the page —
 *   and this one waits behind it. Putting it in that one's place would drop the
 *   first without a word.
 * - `begin`: nothing is waiting, so the question goes out. A question asked
 *   about a row holds no write and is simply replaced.
 */
export function gateDecision(
  httpCatalog: boolean,
  offer: boolean,
  current: CascadeAsk | null,
  currentHoldsWrite: boolean,
): 'write' | 'queue' | 'begin' {
  // Nothing can interrupt a write without the catalog, and nothing is asked of
  // one when the person has switched the offer off.
  if (!httpCatalog || !offer) return 'write';
  if (current && current.mode === 'apply' && currentHoldsWrite) return 'queue';
  return 'begin';
}
