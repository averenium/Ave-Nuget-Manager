import React, { useCallback, useEffect, useState } from 'react';
import { DependentCascadePage, type CascadePageSnapshot } from './components/DependentCascadePage';
import { onMessage, sendMessage } from './vscodeApi';
import type { CascadeAction } from '../messages';

/**
 * The root the dependents page loads (#109): the same bundle as the panel,
 * picked by the `data-route` flag on the body. It has no part in the panel's
 * state — it holds the one snapshot the host sends it, and answers with one
 * action.
 */
export function CascadePageApp() {
  const [snapshot, setSnapshot] = useState<CascadePageSnapshot | null>(null);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === 'CASCADE_PAGE_SNAPSHOT') {
        setSnapshot({ requestId: msg.requestId, result: msg.result, waiting: msg.waiting, stale: msg.stale });
      } else if (msg.type === 'CASCADE_PAGE_MARK_STALE') {
        setSnapshot((current) => (current && current.requestId === msg.requestId ? { ...current, stale: true } : current));
      }
    });
    sendMessage({ type: 'WEBVIEW_READY' });
    return off;
  }, []);

  const onAction = useCallback((action: CascadeAction | 'recompute' | 'close') => {
    if (!snapshot) return;
    sendMessage({ type: 'CASCADE_PAGE_ACTION', requestId: snapshot.requestId, action });
  }, [snapshot]);

  if (!snapshot) return <div className="empty-state">Loading…</div>;
  return <DependentCascadePage snapshot={snapshot} onAction={onAction} />;
}
