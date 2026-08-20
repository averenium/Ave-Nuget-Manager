import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { WorkspaceScope } from './types';
import type { ExtensionMessage } from './messages';

/** Hides the panel WebviewView while the editor/new-window panel is the live UI. */
export const EDITOR_OPEN_CONTEXT = 'averenium.nugetManager.editorOpen';

/**
 * Hosts the NuGet UI as a panel `WebviewView` (default) or as a `WebviewPanel`
 * (editor tab / new window). One live webview at a time in v1.
 *
 * Lifecycle:
 *  - attach() / onDidReceiveMessage() may be called BEFORE resolveWebviewView().
 *  - Pending handlers are re-bound when the view resolves or an editor panel opens.
 *  - Moving a WebviewView disposes it and re-resolves; HTML is rebuilt so React
 *    remounts and WEBVIEW_READY runs init again.
 */
export class NugetManagerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'averenium.nugetManagerView';
  static readonly editorViewType = 'averenium.nugetManager.editor';

  private _view?: vscode.WebviewView;
  private _editor?: vscode.WebviewPanel;
  private _currentScope?: WorkspaceScope;

  private _pendingHandlers: Array<(message: unknown) => void> = [];
  private _handlerDisposables: vscode.Disposable[] = [];
  private _viewDisposeSub?: vscode.Disposable;
  private _editorDisposeSub?: vscode.Disposable;

  private _onViewReady?: () => void;
  private _onSurface?: () => void;
  private _surfaced = false;

  private _clientReady = false;
  private readonly _outboundQueue: ExtensionMessage[] = [];
  private _htmlBuilt = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Called once the first surface (panel view or editor) exists — e.g. start file watch. */
  setOnSurface(cb: () => void): void {
    this._onSurface = cb;
    if (this._surfaced) cb();
  }

  private _notifySurface(): void {
    if (this._surfaced) return;
    this._surfaced = true;
    this._onSurface?.();
  }

  private _activeWebview(): vscode.Webview | undefined {
    return this._editor?.webview ?? this._view?.webview;
  }

  get hasEditor(): boolean {
    return this._editor !== undefined;
  }

  // ─── WebviewViewProvider ───────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._notifySurface();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
      ],
    };

    // Every resolve is a new view instance (first open, or after move / editor close).
    // Hide/show with retainContextWhenHidden does not re-resolve.
    if (!this._editor) {
      this._clientReady = false;
      this._outboundQueue.length = 0;
      webviewView.webview.html = this._buildHtml(webviewView.webview);
      this._htmlBuilt = true;
    }

    this._bindHandlers(webviewView.webview);

    this._viewDisposeSub?.dispose();
    this._viewDisposeSub = webviewView.onDidDispose(() => {
      this._view = undefined;
      this._viewDisposeSub = undefined;
      if (this._editor) {
        this._bindHandlers(this._editor.webview);
        return;
      }
      this._resetSurface();
    });

    this._onViewReady?.();
  }

  /**
   * Host the same UI as an editor tab. Optionally move that tab to a new window
   * (`workbench.action.moveEditorToNewWindow`).
   */
  async openInEditor(moveToNewWindow: boolean): Promise<void> {
    if (this._editor) {
      this._editor.reveal(this._editor.viewColumn ?? vscode.ViewColumn.Active);
      if (moveToNewWindow) {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      }
      return;
    }

    this._notifySurface();
    this._clientReady = false;
    this._outboundQueue.length = 0;

    const panel = vscode.window.createWebviewPanel(
      NugetManagerViewProvider.editorViewType,
      'NuGet',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png');
    panel.webview.html = this._buildHtml(panel.webview);
    this._htmlBuilt = true;
    this._editor = panel;
    this._bindHandlers(panel.webview);

    await vscode.commands.executeCommand('setContext', EDITOR_OPEN_CONTEXT, true);

    this._editorDisposeSub = panel.onDidDispose(() => {
      this._editor = undefined;
      this._editorDisposeSub = undefined;
      void vscode.commands.executeCommand('setContext', EDITOR_OPEN_CONTEXT, false);
      if (!this._view) {
        this._resetSurface();
      } else {
        this._bindHandlers(this._view.webview);
      }
    });

    if (moveToNewWindow) {
      panel.reveal(vscode.ViewColumn.Active);
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }
  }

  private _resetSurface(): void {
    this._handlerDisposables.forEach((d) => d.dispose());
    this._handlerDisposables = [];
    this._htmlBuilt = false;
    this._clientReady = false;
    this._outboundQueue.length = 0;
  }

  private _bindHandlers(webview: vscode.Webview): void {
    this._handlerDisposables.forEach((d) => d.dispose());
    this._handlerDisposables = [];
    for (const handler of this._pendingHandlers) {
      this._handlerDisposables.push(webview.onDidReceiveMessage(handler));
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  setOnViewReady(cb: () => void): void {
    this._onViewReady = cb;
    if (this._view || this._editor) {
      cb();
    }
  }

  setScope(scope: WorkspaceScope): void {
    this._currentScope = scope;
  }

  getCurrentScope(): WorkspaceScope | undefined {
    return this._currentScope;
  }

  get isClientReady(): boolean {
    return this._clientReady;
  }

  reloadHtml(): void {
    const webview = this._activeWebview();
    if (!webview) return;
    this._clientReady = false;
    this._outboundQueue.length = 0;
    webview.html = this._buildHtml(webview);
    this._htmlBuilt = true;
  }

  postMessage(message: ExtensionMessage): void {
    const webview = this._activeWebview();
    if (!webview || !this._clientReady) {
      this._outboundQueue.push(message);
      return;
    }
    void webview.postMessage(message);
  }

  markClientReady(): void {
    this._clientReady = true;
    const queued = this._outboundQueue.splice(0);
    const webview = this._activeWebview();
    for (const message of queued) {
      void webview?.postMessage(message);
    }
  }

  onDidReceiveMessage(handler: (message: unknown) => void): vscode.Disposable {
    this._pendingHandlers.push(handler);

    const webview = this._activeWebview();
    if (webview) {
      const d = webview.onDidReceiveMessage(handler);
      this._handlerDisposables.push(d);
    }

    return new vscode.Disposable(() => {
      this._pendingHandlers = this._pendingHandlers.filter((h) => h !== handler);
      this._handlerDisposables.forEach((d) => d.dispose());
      this._handlerDisposables = [];
      const active = this._activeWebview();
      if (active) {
        for (const h of this._pendingHandlers) {
          this._handlerDisposables.push(active.onDidReceiveMessage(h));
        }
      }
    });
  }

  get isVisible(): boolean {
    return this._editor?.visible ?? this._view?.visible ?? false;
  }

  async reveal(): Promise<void> {
    if (this._editor) {
      this._editor.reveal(this._editor.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    await vscode.commands.executeCommand(`${NugetManagerViewProvider.viewId}.focus`);
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const cacheBust = Date.now().toString();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'bundle.js'),
    ).with({ query: `v=${cacheBust}` });
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'bundle.css'),
    ).with({ query: `v=${cacheBust}` });

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" nonce="${nonce}" href="${styleUri}" />
  <title>NuGet Manager</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
