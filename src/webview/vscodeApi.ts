import type { WebviewMessage, ExtensionMessage } from '../../messages';

// Re-export from the root src for webview consumers
export type { WebviewMessage, ExtensionMessage };

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Acquire once — calling it multiple times throws in the VSCode webview runtime
const vscode = acquireVsCodeApi();

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
