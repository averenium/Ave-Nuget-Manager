import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

declare global {
  interface Window {
    __nugetReactRoot?: Root;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  const root = window.__nugetReactRoot ?? createRoot(rootEl);
  window.__nugetReactRoot = root;
  root.render(<App />);
}
