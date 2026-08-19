import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { WorkspaceScope } from './types';
import type { ExtensionMessage } from './messages';

/**
 * Implements vscode.WebviewViewProvider to render the NuGet Manager in the
 * bottom panel (registered via `contributes.viewsContainers.panel`).
 *
 * Lifecycle fix:
 *  - attach() / onDidReceiveMessage() may be called BEFORE resolveWebviewView().
 *  - We store pending handlers and re-register them when the view resolves.
 *  - setScope() immediately pushes INIT_STATE if the view is already open.
 */
export class NugetManagerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'averenium.nugetManagerView';

  private _view?: vscode.WebviewView;
  private _currentScope?: WorkspaceScope;

  // Callbacks registered via onDidReceiveMessage() before the view is resolved
  private _pendingHandlers: Array<(message: unknown) => void> = [];
  private _handlerDisposables: vscode.Disposable[] = [];

  // Callback to call when the view is first resolved (set by broker)
  private _onViewReady?: () => void;

  /** React has subscribed — outbound messages can be delivered. */
  private _clientReady = false;
  private readonly _outboundQueue: ExtensionMessage[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  // ─── WebviewViewProvider implementation ───────────────────────────────────

  private _htmlBuilt = false;

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
      ],
    };

    // Set HTML only on the very first resolve — retainContextWhenHidden keeps
    // the webview alive between hide/show cycles, so setting html again would
    // tear down and re-mount the React app, causing a double WEBVIEW_READY.
    if (!this._htmlBuilt) {
      webviewView.webview.html = this._buildHtml(webviewView.webview);
      this._htmlBuilt = true;
    }

    // Re-register any handlers that were attached before the view was ready
    this._handlerDisposables.forEach((d) => d.dispose());
    this._handlerDisposables = [];

    for (const handler of this._pendingHandlers) {
      const d = webviewView.webview.onDidReceiveMessage(handler);
      this._handlerDisposables.push(d);
    }

    webviewView.onDidDispose(() => {
      this._handlerDisposables.forEach((d) => d.dispose());
      this._handlerDisposables = [];
      this._view = undefined;
      this._htmlBuilt = false;
      this._clientReady = false;
    });

    // Notify the broker that the view is now available
    this._onViewReady?.();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Register a callback to invoke once the WebviewView is first resolved.
   * If it's already resolved, the callback is invoked immediately.
   */
  setOnViewReady(cb: () => void): void {
    this._onViewReady = cb;
    if (this._view) {
      cb(); // already resolved — call immediately
    }
  }

  /**
   * Update the active scope. If the view is already open, push INIT_STATE
   * immediately so the webview re-initialises without waiting for WEBVIEW_READY.
   * The broker will call this and then push the data itself.
   */
  setScope(scope: WorkspaceScope): void {
    this._currentScope = scope;
  }

  getCurrentScope(): WorkspaceScope | undefined {
    return this._currentScope;
  }

  get isClientReady(): boolean {
    return this._clientReady;
  }

  /** Rebuild HTML so a newly compiled bundle is picked up (watch mode). */
  reloadHtml(): void {
    if (!this._view) return;
    this._clientReady = false;
    this._outboundQueue.length = 0;
    this._view.webview.html = this._buildHtml(this._view.webview);
    this._htmlBuilt = true;
  }

  /** Send a typed message to the webview. Queued until React signals WEBVIEW_READY. */
  postMessage(message: ExtensionMessage): void {
    if (!this._view || !this._clientReady) {
      this._outboundQueue.push(message);
      return;
    }
    void this._view.webview.postMessage(message);
  }

  /**
   * Flush queued host→webview messages. Called when the webview sends WEBVIEW_READY
   * (listener is already attached on the React side).
   */
  markClientReady(): void {
    this._clientReady = true;
    const queued = this._outboundQueue.splice(0);
    for (const message of queued) {
      void this._view?.webview.postMessage(message);
    }
  }

  /**
   * Register a handler for messages arriving from the webview.
   * Safe to call before the view is resolved — the handler will be re-registered
   * when resolveWebviewView fires.
   */
  onDidReceiveMessage(handler: (message: unknown) => void): vscode.Disposable {
    this._pendingHandlers.push(handler);

    if (this._view) {
      // View already resolved — register immediately
      const d = this._view.webview.onDidReceiveMessage(handler);
      this._handlerDisposables.push(d);
    }

    // Return a disposable that removes the handler from both lists
    return new vscode.Disposable(() => {
      this._pendingHandlers = this._pendingHandlers.filter((h) => h !== handler);
      this._handlerDisposables.forEach((d) => d.dispose());
      this._handlerDisposables = [];
      // Re-register remaining handlers
      if (this._view) {
        for (const h of this._pendingHandlers) {
          this._handlerDisposables.push(
            this._view.webview.onDidReceiveMessage(h),
          );
        }
      }
    });
  }

  get isVisible(): boolean {
    return this._view?.visible ?? false;
  }

  // ─── HTML generation ──────────────────────────────────────────────────────

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
