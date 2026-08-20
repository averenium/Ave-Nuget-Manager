import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

function PackageIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        d="M2.5 5.2 8 2.5l5.5 2.7L8 8 2.5 5.2Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        d="M2.5 5.2V11L8 13.7 13.5 11V5.2M8 8v5.7"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        d="M13.2 8A5.2 5.2 0 1 1 11 3.6"
      />
      <path fill="currentColor" d="M11 2.2v3.3h3.3z" />
    </svg>
  );
}

export function ToolbarRestoreRefresh({ disabled }: { disabled?: boolean }) {
  const { state, send } = useNugetManager();
  const busy = disabled || !!state.workspaceActivity;
  return (
    <>
      <button
        type="button"
        className="pkg-toolbar__refresh"
        title="Restore packages (keeps latest-version cache)"
        aria-label="Restore packages"
        disabled={busy}
        onClick={() => send({ type: 'RESTORE_PACKAGES' })}
      >
        <PackageIcon />
      </button>
      <button
        type="button"
        className="pkg-toolbar__refresh"
        title="Force refresh (clears latest-version cache)"
        aria-label="Force refresh packages"
        disabled={busy}
        onClick={() => send({ type: 'FORCE_REFRESH' })}
      >
        <RefreshIcon />
      </button>
    </>
  );
}
