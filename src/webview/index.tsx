import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportWebviewError } from './vscodeApi';
import './styles/global.css';

declare global {
  interface Window {
    __nugetReactRoot?: Root;
  }
}

window.addEventListener('error', (event) => {
  reportWebviewError('window', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportWebviewError('unhandledrejection', event.reason);
});

const rootEl = document.getElementById('root');
if (rootEl) {
  try {
    const root = window.__nugetReactRoot ?? createRoot(rootEl);
    window.__nugetReactRoot = root;
    root.render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    );
  } catch (err) {
    reportWebviewError('bootstrap', err);
    rootEl.textContent = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
}
