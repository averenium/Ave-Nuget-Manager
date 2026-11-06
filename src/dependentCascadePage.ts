import * as vscode from 'vscode';
import type { CascadeResult } from './cascadeResult';
import type { Logger } from './logger';
import type { CascadeAction, ExtensionMessage, WebviewMessage } from './messages';
import { buildWebviewHtml } from './webviewHtml';

/**
 * What the page is open on (#109). `key` is what makes two requests the same
 * question — package, target version, project and framework — so asking again
 * reveals the page instead of opening another.
 */
export interface CascadePageEntry {
  requestId: string;
  result: CascadeResult;
  /** A write is held for this closure; closing the page without a decision cancels it. */
  waiting: boolean;
}

export interface CascadePageCallbacks {
  /** A decision taken on the page. The panel carries it out: every write runs where every write runs. */
  onDecision: (entry: CascadePageEntry, action: CascadeAction) => void;
  /** The page is gone. `acted` is true when a decision closed it; false when the tab was simply closed. */
  onClosed: (entry: CascadePageEntry, acted: boolean) => void;
  /** The same question asked again, or `undefined` when it can no longer be answered. */
  recompute: (entry: CascadePageEntry) => Promise<CascadeResult | undefined>;
}

export function cascadeKey(result: CascadeResult): string {
  return JSON.stringify([result.packageId, result.toVersion, result.projectPath, result.framework]);
}

/**
 * The page that reviews a closure too large to read in a popup (#109): one
 * `WebviewPanel` opening beside the panel, not instead of it.
 *
 * It has a host of its own rather than going through `NugetManagerViewProvider`,
 * which by construction binds exactly one surface at a time — its handlers, its
 * client-ready handshake, its outbound queue and the view↔editor rebinding on
 * dispose. Teaching that machinery to hold two live surfaces would put the
 * fiddliest part of the extension's hosting at risk for no gain here.
 *
 * The channel is small: the closure out (`CASCADE_PAGE_SNAPSHOT`, and
 * `CASCADE_PAGE_MARK_STALE`), and one action back (`CASCADE_PAGE_ACTION`).
 */
export class CascadePageHost implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private _entry?: CascadePageEntry;
  private _stale = false;
  private _acted = false;
  private _ready = false;
  private _subs: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _callbacks: CascadePageCallbacks,
    private readonly _log?: Pick<Logger, 'info' | 'error'>,
  ) {}

  get current(): CascadePageEntry | undefined {
    return this._entry;
  }

  get isOpen(): boolean {
    return this._panel !== undefined;
  }

  /**
   * Opens the page on `entry`, or reveals it when one is open. A request for
   * the same question only reveals; a request for another replaces the snapshot,
   * since the page already open is of no further use to the person who just
   * asked about something else.
   */
  open(entry: CascadePageEntry): void {
    if (this._panel && this._entry) {
      const same = cascadeKey(this._entry.result) === cascadeKey(entry.result);
      if (!same) {
        const replaced = this._entry;
        // A write held for the closure being replaced is not going to be answered.
        if (replaced.waiting && !this._acted) this._callbacks.onClosed(replaced, false);
        this._entry = entry;
        this._stale = false;
        this._acted = false;
      } else {
        // The same question, asked again: the page stays, and answers the ask
        // that is current — a write held for the newer click is what a decision
        // on this page would settle.
        this._entry = entry;
        this._stale = false;
      }
      this._panel.reveal(this._panel.viewColumn ?? vscode.ViewColumn.Beside);
      this._panel.title = titleFor(this._entry.result);
      this._post(this._snapshot());
      return;
    }

    this._entry = entry;
    this._stale = false;
    this._acted = false;
    this._ready = false;
    const panel = vscode.window.createWebviewPanel(
      'averenium.nugetManager.cascadePage',
      titleFor(entry.result),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
      },
    );
    this._panel = panel;
    panel.webview.html = buildWebviewHtml(panel.webview, this._extensionUri, this._log, {
      route: 'cascade-page',
      title: titleFor(entry.result),
      loadingText: 'Loading…',
    });
    this._subs.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage | { type: 'WEBVIEW_READY' }) => {
        void this._receive(message);
      }),
      panel.onDidDispose(() => this._disposed()),
    );
  }

  /**
   * The same page, with more in the closure than it opened with (the release
   * notes, read after it opened). Keeps the stale mark; a refresh is not a
   * recompute.
   */
  refresh(requestId: string, result: CascadeResult): void {
    if (!this._entry || this._entry.requestId !== requestId) return;
    this._entry = { ...this._entry, result };
    this._post(this._snapshot());
  }

  /** The panel has moved on from what the page was computed for: keep the snapshot, mark it. */
  markStale(requestId: string): void {
    if (!this._entry || this._entry.requestId !== requestId || this._stale) return;
    this._stale = true;
    this._post({ type: 'CASCADE_PAGE_MARK_STALE', requestId });
  }

  dispose(): void {
    this._acted = true;
    this._panel?.dispose();
  }

  private _snapshot(): ExtensionMessage {
    const entry = this._entry!;
    return {
      type: 'CASCADE_PAGE_SNAPSHOT',
      requestId: entry.requestId,
      result: entry.result,
      waiting: entry.waiting,
      stale: this._stale,
    };
  }

  private _post(message: ExtensionMessage): void {
    if (!this._panel || !this._ready) return;
    void this._panel.webview.postMessage(message);
  }

  private async _receive(message: WebviewMessage | { type: 'WEBVIEW_READY' }): Promise<void> {
    const entry = this._entry;
    if (!entry) return;

    if (message.type === 'WEBVIEW_READY') {
      this._ready = true;
      this._post(this._snapshot());
      return;
    }
    if (message.type !== 'CASCADE_PAGE_ACTION' || message.requestId !== entry.requestId) return;

    if (message.action === 'recompute') {
      const result = await this._callbacks.recompute(entry);
      if (!result || this._entry !== entry) return;
      this._entry = { ...entry, result };
      this._stale = false;
      this._post(this._snapshot());
      return;
    }

    // Every other action ends the page's job: the decision goes to the panel,
    // and the page closes itself — a page the person must leave to act is worse
    // than the popup it replaced, and one left open would go on describing a
    // closure that has just been written.
    this._acted = true;
    if (message.action !== 'close') this._callbacks.onDecision(entry, message.action);
    this._panel?.dispose();
  }

  private _disposed(): void {
    const entry = this._entry;
    const acted = this._acted;
    for (const sub of this._subs) sub.dispose();
    this._subs = [];
    this._panel = undefined;
    this._entry = undefined;
    this._ready = false;
    if (entry) this._callbacks.onClosed(entry, acted);
  }
}

function titleFor(result: CascadeResult): string {
  return `What moves with ${result.packageId} ${result.toVersion}`;
}
