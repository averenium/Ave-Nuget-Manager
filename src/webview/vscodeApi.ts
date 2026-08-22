import type { WebviewMessage, ExtensionMessage } from '../../messages';

// Re-export from the root src for webview consumers
export type { WebviewMessage, ExtensionMessage };

type VsCodeApi = {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    __nugetVsCodeApi?: VsCodeApi;
  }
}

// Acquire once and stash on window — Vite HMR re-evaluates this module,
// but the webview runtime throws if acquireVsCodeApi() is called again.
const vscode: VsCodeApi = window.__nugetVsCodeApi ?? acquireVsCodeApi();
window.__nugetVsCodeApi = vscode;

export function sendMessage(msg: WebviewMessage): void {
  vscode.postMessage(msg);
}

export function onMessage(handler: (msg: ExtensionMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    handler(event.data as ExtensionMessage);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export function getState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}

export type WebviewPersistedState = {
  vulnHintDismissedFingerprint?: string | null;
};

export function getPersistedState(): WebviewPersistedState {
  return getState<WebviewPersistedState>() ?? {};
}

export function patchPersistedState(patch: Partial<WebviewPersistedState>): void {
  setState({ ...getPersistedState(), ...patch });
}
