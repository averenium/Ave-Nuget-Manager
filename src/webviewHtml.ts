import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Logger } from './logger';

export interface WebviewHtmlOptions {
  /** Which root the bundle renders — absent for the panel itself (#109). */
  route?: 'cascade-page';
  title?: string;
  loadingText?: string;
}

/**
 * The page every surface of this extension loads: the same bundle and
 * stylesheet, so a second surface (the dependents page, #109) costs a route
 * flag on the body rather than a second build.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  log?: Pick<Logger, 'info' | 'error'>,
  options: WebviewHtmlOptions = {},
): string {
  const nonce = randomUUID().replace(/-/g, '');
  const cacheBust = Date.now().toString();
  const bundleFs = path.join(extensionUri.fsPath, 'dist', 'webview', 'bundle.js');
  const bundleOk = fs.existsSync(bundleFs);
  if (!bundleOk) {
    log?.error(`webview bundle missing: ${bundleFs}`);
  }
  const rootText = bundleOk
    ? (options.loadingText ?? 'Loading NuGet…')
    : 'UI bundle missing. Run npm run build:webview, then Reload Window.';

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'bundle.js'),
  ).with({ query: `v=${cacheBust}` });
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'bundle.css'),
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
<title>${options.title ?? 'NuGet Manager'}</title>
</head>
<body${options.route ? ` data-route="${options.route}"` : ''}>
<div id="root">${rootText}</div>
<script nonce="${nonce}">
  (function () {
    var bundle = document.currentScript && document.currentScript.nextElementSibling;
    if (!bundle) return;
    bundle.addEventListener('error', function () {
      var el = document.getElementById('root');
      if (el) el.textContent = 'Failed to load UI bundle (dist/webview/bundle.js). Rebuild with npm run build:webview, then Reload Window.';
      try {
        var api = window.__nugetVsCodeApi || acquireVsCodeApi();
        window.__nugetVsCodeApi = api;
        api.postMessage({
          type: 'WEBVIEW_ERROR',
          source: 'bundle',
          message: 'Failed to load bundle.js',
        });
      } catch (e) {}
    });
  })();
</script>
<script nonce="${nonce}" id="nuget-bundle" src="${scriptUri}"></script>
</body>
</html>`;
}
