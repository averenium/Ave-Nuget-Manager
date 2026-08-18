import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { sendMessage } from './vscodeApi';
import './styles/global.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(<App />);

  // Notify extension host that the webview is ready to receive messages
  sendMessage({ type: 'WEBVIEW_READY' });
}
