import type { CascadeResult } from '../../cascadeResult';
import {
  INITIAL_CASCADE, cascadeBatchStatus, gateDecision, reduceCascade, startsOurBatch,
  type CascadeAsk, type CascadeBatch, type CascadeDecision,
} from '../../webview/utils/cascadeState';
import { showsCascadeCheck } from '../../webview/utils/dependentsRequest';

const ask = (requestId: string): CascadeAsk => ({
  requestId, mode: 'apply', answered: false, result: null, pageOpen: false, pageEpoch: 0,
  request: { packageId: 'Example.Messaging.Transport', fromVersion: '6.8.1', toVersion: '7.2.2', projectPath: 'D:/src/Example.Shop.csproj', frameworks: ['net10.0'] },
});
const result = { outcome: 'proposal' } as CascadeResult;

describe('the dependents slice of the panel state (#109)', () => {
  it('starts with the HTTP catalog off, so nothing is offered until the host says otherwise', () => {
    expect(INITIAL_CASCADE).toEqual({ httpCatalog: false, offer: true, current: null, decision: null, queued: 0, batch: null });
    expect(reduceCascade(INITIAL_CASCADE, { kind: 'init', httpCatalog: true }).httpCatalog).toBe(true);
    expect(reduceCascade({ ...INITIAL_CASCADE, httpCatalog: true }, { kind: 'http', enabled: false }).httpCatalog).toBe(false);
  });

  it('keeps an answer for the question it answers', () => {
    const asked = reduceCascade(INITIAL_CASCADE, { kind: 'ask', ask: ask('a') });
    const answered = reduceCascade(asked, { kind: 'answer', requestId: 'a', result });
    expect(answered.current).toMatchObject({ requestId: 'a', answered: true, result });
  });

  it('drops an answer to a question the person has already moved past', () => {
    const asked = reduceCascade(reduceCascade(INITIAL_CASCADE, { kind: 'ask', ask: ask('a') }), { kind: 'ask', ask: ask('b') });
    const stale = reduceCascade(asked, { kind: 'answer', requestId: 'a', result });
    expect(stale).toBe(asked);
    expect(stale.current?.answered).toBe(false);
  });

  it('ends only the question it was told to end', () => {
    const asked = reduceCascade(INITIAL_CASCADE, { kind: 'ask', ask: ask('b') });
    expect(reduceCascade(asked, { kind: 'end', requestId: 'a' })).toBe(asked);
    expect(reduceCascade(asked, { kind: 'end', requestId: 'b' }).current).toBeNull();
  });

  it('notes that the page is open on the question, and ignores a page for another', () => {
    const asked = reduceCascade(INITIAL_CASCADE, { kind: 'ask', ask: ask('a') });
    expect(reduceCascade(asked, { kind: 'page', requestId: 'a', open: true }).current?.pageOpen).toBe(true);
    expect(reduceCascade(asked, { kind: 'page', requestId: 'x', open: true })).toBe(asked);
  });

  it('holds a decision taken on the page until it is carried out', () => {
    const decision = { type: 'CASCADE_DECISION', requestId: 'a', action: 'take-all' } as CascadeDecision;
    const held = reduceCascade(INITIAL_CASCADE, { kind: 'decision', decision });
    expect(held.decision).toBe(decision);
    expect(reduceCascade(held, { kind: 'decision-taken' }).decision).toBeNull();
  });
});

describe('the page and the panel agreeing on what is current (#109)', () => {
  const opened = () => reduceCascade(reduceCascade(INITIAL_CASCADE, { kind: 'ask', ask: ask('a') }), { kind: 'page', requestId: 'a', open: true });

  it('counts each time the host says the page is open, so a recompute can be marked stale again', () => {
    const first = opened();
    expect(first.current?.pageEpoch).toBe(1);
    const recomputed = reduceCascade(first, { kind: 'page', requestId: 'a', open: true, fromVersion: '7.0.0' });
    expect(recomputed.current?.pageEpoch).toBe(2);
  });

  it('does not count the page closing', () => {
    expect(reduceCascade(opened(), { kind: 'page', requestId: 'a', open: false }).current?.pageEpoch).toBe(1);
  });

  it('measures the panel against the version a recompute started from, not the one the page opened with', () => {
    const recomputed = reduceCascade(opened(), { kind: 'page', requestId: 'a', open: true, fromVersion: '7.0.0' });
    expect(recomputed.current?.request.fromVersion).toBe('7.0.0');
    expect(opened().current?.request.fromVersion).toBe('6.8.1');
  });

  it('keeps count of the writes waiting behind the question in front', () => {
    expect(reduceCascade(INITIAL_CASCADE, { kind: 'queue', count: 2 }).queued).toBe(2);
  });
});

describe('following the batch a decision sent (#109)', () => {
  const batch: CascadeBatch = { packageId: 'Example.Messaging.Transport', toVersion: '6.8.1', project: 'Example.Shop.Infrastructure' };
  const job = (statuses: Array<'ok' | 'error' | 'timeout' | 'cancelled' | 'pending' | 'running'>, finished = true) => ({
    items: statuses.map((status) => ({ status })),
    finishedAt: finished ? 1 : undefined,
  });

  it('claims the first job the host starts after the batch was sent, and no later one', () => {
    const sent = reduceCascade(INITIAL_CASCADE, { kind: 'batch-sent', batch });
    expect(startsOurBatch(INITIAL_CASCADE)).toBe(false);
    expect(startsOurBatch(sent)).toBe(true);

    const started = reduceCascade(sent, { kind: 'batch-started', jobId: 'batch-1' });
    expect(started.batch?.jobId).toBe('batch-1');
    expect(startsOurBatch(started)).toBe(false);
    expect(reduceCascade(started, { kind: 'batch-started', jobId: 'batch-2' }).batch?.jobId).toBe('batch-1');
  });

  it('forgets the batch once it has been read', () => {
    const sent = reduceCascade(INITIAL_CASCADE, { kind: 'batch-sent', batch });
    expect(reduceCascade(sent, { kind: 'batch-done' }).batch).toBeNull();
  });

  it('says what is being updated before the host has started the job', () => {
    expect(cascadeBatchStatus(batch, undefined)).toEqual({
      phase: 'running',
      text: 'Updating Example.Messaging.Transport 6.8.1 and what has to move with it in Example.Shop.Infrastructure…',
    });
  });

  it('counts how far it has got while it runs', () => {
    expect(cascadeBatchStatus(batch, job(['ok', 'running', 'pending'], false))).toEqual({
      phase: 'running',
      text: 'Updating Example.Messaging.Transport 6.8.1 and 2 packages that had to move with it in Example.Shop.Infrastructure… 1 of 3 done.',
    });
  });

  it('says it was updated, and what moved with it, once every item went through', () => {
    expect(cascadeBatchStatus(batch, job(['ok', 'ok']))).toEqual({
      phase: 'ok',
      text: 'Updated Example.Messaging.Transport 6.8.1 and 1 package that had to move with it in Example.Shop.Infrastructure.',
    });
  });

  it('says how many did not go through, and points to the error, when any failed', () => {
    expect(cascadeBatchStatus(batch, job(['error', 'ok']))).toEqual({
      phase: 'failed',
      text: '1 of 2 updates did not go through in Example.Shop.Infrastructure; 1 did. The reason is in the error banner.',
    });
    expect(cascadeBatchStatus(batch, job(['timeout', 'ok'])).phase).toBe('failed');
  });

  it('says it stopped when the person cancelled it', () => {
    expect(cascadeBatchStatus(batch, job(['ok', 'cancelled']))).toEqual({
      phase: 'stopped',
      text: 'Stopped. 1 of 2 updates were made in Example.Shop.Infrastructure.',
    });
  });
});

describe('what a write that wants the dependents question does (#109)', () => {
  const waiting = { ...ask('a'), mode: 'apply' as const };

  it('goes ahead when the question cannot be asked', () => {
    expect(gateDecision(false, true, null, false)).toBe('write');
    expect(gateDecision(false, true, waiting, true)).toBe('write');
  });

  it('goes ahead without the check when the person has switched the offer off, even behind a write that is held', () => {
    expect(gateDecision(true, false, null, false)).toBe('write');
    expect(gateDecision(true, false, waiting, true)).toBe('write');
  });

  it('is on until the host says otherwise, and follows what it says', () => {
    expect(INITIAL_CASCADE.offer).toBe(true);
    expect(reduceCascade(INITIAL_CASCADE, { kind: 'init', httpCatalog: true, offer: false }).offer).toBe(false);
    expect(reduceCascade(INITIAL_CASCADE, { kind: 'init', httpCatalog: true }).offer).toBe(true);
    expect(reduceCascade(INITIAL_CASCADE, { kind: 'offer', enabled: false }).offer).toBe(false);
    expect(reduceCascade({ ...INITIAL_CASCADE, offer: false }, { kind: 'offer', enabled: true }).offer).toBe(true);
  });

  it('waits behind a write that is held for its answer rather than replacing it', () => {
    expect(gateDecision(true, true, waiting, true)).toBe('queue');
  });

  it('starts its own question when nothing is held', () => {
    expect(gateDecision(true, true, null, false)).toBe('begin');
    // a question asked about a row holds no write and is simply replaced
    expect(gateDecision(true, true, { ...waiting, mode: 'asked' }, false)).toBe('begin');
    // an apply whose write was already released or dropped holds nothing either
    expect(gateDecision(true, true, waiting, false)).toBe('begin');
  });
});

describe('the right-click entry "Check what else has to move" (#109)', () => {
  const check = { packageId: 'Example.Core', fromVersion: '1.0.0', toVersion: '2.0.0', projectPath: 'D:/a.csproj', frameworks: [] };

  it('is hidden when the HTTP catalog is off: not disabled, not a popup explaining itself', () => {
    expect(showsCascadeCheck(false, check)).toBe(false);
  });

  it('is drawn when the catalog is on and the row has an update to ask about', () => {
    expect(showsCascadeCheck(true, check)).toBe(true);
    expect(showsCascadeCheck(true, undefined)).toBe(false);
  });
});
