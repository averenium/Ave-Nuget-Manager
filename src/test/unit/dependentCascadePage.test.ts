import * as vscode from 'vscode';
import { CascadePageHost, type CascadePageCallbacks, type CascadePageEntry } from '../../dependentCascadePage';
import type { CascadeResult } from '../../cascadeResult';

function result(over: Partial<CascadeResult> = {}): CascadeResult {
  return {
    outcome: 'proposal', mode: 'asked', packageId: 'Example.Messaging.Transport',
    fromVersion: '6.8.1', toVersion: '7.2.2', projectPath: 'D:/src/Example.Shop.csproj', framework: 'net10.0',
    root: { id: 'Example.Messaging.Transport', installedVersion: '6.8.1', proposedVersion: '7.2.2', status: 'moves', children: [] },
    moves: 0, unknowns: 0, leftOut: 0, ...over,
  };
}

const entry = (over: Partial<CascadePageEntry> = {}): CascadePageEntry => ({
  requestId: 'r1', result: result(), waiting: false, ...over,
});

/** A panel the test can drive: the page's messages in, the host's messages out. */
function fakePanel() {
  let received: (m: unknown) => void = () => undefined;
  let disposed: () => void = () => undefined;
  const posted: unknown[] = [];
  const panel = {
    webview: {
      html: '',
      cspSource: 'https://example',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: jest.fn((m: unknown) => { posted.push(m); return Promise.resolve(true); }),
      onDidReceiveMessage: jest.fn((cb: (m: unknown) => void) => { received = cb; return { dispose: jest.fn() }; }),
    },
    title: '',
    reveal: jest.fn(),
    dispose: jest.fn(() => disposed()),
    onDidDispose: jest.fn((cb: () => void) => { disposed = cb; return { dispose: jest.fn() }; }),
    viewColumn: vscode.ViewColumn.Two,
  };
  return { panel, posted, fromPage: (m: unknown) => received(m), closeTab: () => disposed() };
}

function host(callbacks: Partial<CascadePageCallbacks> = {}) {
  const cbs: CascadePageCallbacks = {
    onDecision: jest.fn(),
    onClosed: jest.fn(),
    recompute: jest.fn(async () => undefined),
    ...callbacks,
  };
  return { page: new CascadePageHost(vscode.Uri.file('/ext'), cbs), cbs };
}

describe('CascadePageHost (#109)', () => {
  beforeEach(() => (vscode.window.createWebviewPanel as jest.Mock).mockReset());

  function open(e: CascadePageEntry = entry(), callbacks: Partial<CascadePageCallbacks> = {}) {
    const fake = fakePanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(fake.panel);
    const h = host(callbacks);
    h.page.open(e);
    return { ...fake, ...h };
  }

  it('loads the same bundle with its own route, beside the panel rather than instead of it', () => {
    const { panel } = open();

    const [, , column] = (vscode.window.createWebviewPanel as jest.Mock).mock.calls[0];
    expect(column).toMatchObject({ viewColumn: vscode.ViewColumn.Beside });
    expect(panel.webview.html).toContain('data-route="cascade-page"');
    expect(panel.webview.html).toContain('id="root"');
  });

  it('names the tab after the question it answers, as the mockup does', () => {
    const [, title] = (() => { open(); return (vscode.window.createWebviewPanel as jest.Mock).mock.calls[0]; })();

    expect(title).toBe('What moves with Example.Messaging.Transport 7.2.2');
  });

  it('renames the tab when a different question takes the open page', () => {
    const { page, panel, fromPage } = open();
    fromPage({ type: 'WEBVIEW_READY' });

    page.open(entry({ requestId: 'r2', result: result({ packageId: 'Example.Core', toVersion: '3.0.0' }) }));

    expect(panel.title).toBe('What moves with Example.Core 3.0.0');
  });

  it('renders the closure it was given once the page says it is ready, and not before', () => {
    const { posted, fromPage } = open(entry({ waiting: true }));
    expect(posted).toEqual([]);

    fromPage({ type: 'WEBVIEW_READY' });

    expect(posted).toEqual([expect.objectContaining({
      type: 'CASCADE_PAGE_SNAPSHOT', requestId: 'r1', waiting: true, stale: false,
      result: expect.objectContaining({ packageId: 'Example.Messaging.Transport', toVersion: '7.2.2' }),
    })]);
  });

  it('marks itself stale when the panel moves on, keeping the snapshot', () => {
    const { page, posted, fromPage } = open();
    fromPage({ type: 'WEBVIEW_READY' });

    page.markStale('r1');
    page.markStale('r1');

    expect(posted.filter((m) => (m as { type: string }).type === 'CASCADE_PAGE_MARK_STALE')).toHaveLength(1);
    // a page that opens after being marked stale (a webview reload) is told too
    fromPage({ type: 'WEBVIEW_READY' });
    expect(posted[posted.length - 1]).toMatchObject({ type: 'CASCADE_PAGE_SNAPSHOT', stale: true });
  });

  it('ignores a stale mark for a page it is not showing', () => {
    const { page, posted, fromPage } = open();
    fromPage({ type: 'WEBVIEW_READY' });

    page.markStale('someone-else');

    expect(posted).toHaveLength(1);
  });

  it('reveals the page it already has instead of opening another for the same question', () => {
    const { page, panel } = open();

    page.open(entry({ requestId: 'r2', waiting: true }));

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalled();
    // and the page answers the ask that is current: a decision on it settles the write held since
    expect(page.current).toMatchObject({ requestId: 'r2', waiting: true });
  });

  it('puts the new question on the open page when it is a different one, and cancels what the old one held', () => {
    const { page, cbs, posted, fromPage } = open(entry({ waiting: true }));
    fromPage({ type: 'WEBVIEW_READY' });

    page.open(entry({ requestId: 'r2', result: result({ packageId: 'Example.Core', toVersion: '3.0.0' }) }));

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(cbs.onClosed).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }), false);
    expect(posted[posted.length - 1]).toMatchObject({ requestId: 'r2', result: { packageId: 'Example.Core' } });
  });

  it('hands a decision to the panel and closes itself once it has acted', () => {
    const { fromPage, panel, cbs } = open(entry({ waiting: true }));

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'r1', action: 'take-all' });

    expect(cbs.onDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }), 'take-all');
    expect(panel.dispose).toHaveBeenCalled();
    expect(cbs.onClosed).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }), true);
  });

  it.each(['block', 'cancel', 'update-anyway'] as const)('carries %s to the panel too', (action) => {
    const { fromPage, cbs } = open(entry({ waiting: true }));

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'r1', action });

    expect(cbs.onDecision).toHaveBeenCalledWith(expect.anything(), action);
  });

  it('closes on Close without carrying a decision', () => {
    const { fromPage, cbs, panel } = open();

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'r1', action: 'close' });

    expect(cbs.onDecision).not.toHaveBeenCalled();
    expect(panel.dispose).toHaveBeenCalled();
    expect(cbs.onClosed).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('treats closing the tab with a write waiting as cancelling it', () => {
    const { closeTab, cbs } = open(entry({ waiting: true }));

    closeTab();

    expect(cbs.onClosed).toHaveBeenCalledWith(expect.objectContaining({ waiting: true }), false);
    expect(cbs.onDecision).not.toHaveBeenCalled();
  });

  it('forgets the page once it is closed, so the next request opens a fresh one', () => {
    const { page, closeTab } = open();
    closeTab();
    expect(page.isOpen).toBe(false);

    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(fakePanel().panel);
    page.open(entry({ requestId: 'r3' }));

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it('recomputes in place, clearing the stale mark', async () => {
    const fresh = result({ moves: 3 });
    const { page, fromPage, posted } = open(entry(), { recompute: jest.fn(async () => fresh) });
    fromPage({ type: 'WEBVIEW_READY' });
    page.markStale('r1');

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'r1', action: 'recompute' });
    await Promise.resolve();
    await Promise.resolve();

    expect(posted[posted.length - 1]).toMatchObject({ type: 'CASCADE_PAGE_SNAPSHOT', stale: false, result: { moves: 3 } });
    expect(page.isOpen).toBe(true);
  });

  it('keeps the old snapshot, still stale, when a recompute cannot be answered', async () => {
    const { page, fromPage, posted } = open(entry(), { recompute: jest.fn(async () => undefined) });
    fromPage({ type: 'WEBVIEW_READY' });
    page.markStale('r1');
    const before = posted.length;

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'r1', action: 'recompute' });
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toHaveLength(before);
  });

  it('takes more in the closure after it opened without losing the stale mark', () => {
    const { page, posted, fromPage } = open();
    fromPage({ type: 'WEBVIEW_READY' });
    page.markStale('r1');

    page.refresh('r1', result({ moves: 4 }));

    expect(posted[posted.length - 1]).toMatchObject({ type: 'CASCADE_PAGE_SNAPSHOT', stale: true, result: { moves: 4 } });
  });

  it('leaves a page showing another request alone when a refresh arrives late', () => {
    const { page, posted, fromPage } = open();
    fromPage({ type: 'WEBVIEW_READY' });
    const before = posted.length;

    page.refresh('other', result({ moves: 9 }));

    expect(posted).toHaveLength(before);
  });

  it('ignores an action addressed to another request', () => {
    const { fromPage, cbs, panel } = open();

    fromPage({ type: 'CASCADE_PAGE_ACTION', requestId: 'other', action: 'take-all' });

    expect(cbs.onDecision).not.toHaveBeenCalled();
    expect(panel.dispose).not.toHaveBeenCalled();
  });
});
