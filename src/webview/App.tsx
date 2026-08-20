import React from 'react';
import { NugetManagerProvider, useNugetManager } from './context/NugetManagerContext';
import { PackagesTab } from './components/PackagesTab';
import { SourcesTab } from './components/SourcesTab';
import { UpdatesTab } from './components/UpdatesTab';
import { LogTab } from './components/LogTab';
import * as pathUtils from './utils/pathUtils';

const TABS = [
  { id: 'packages', label: 'Packages' },
  { id: 'updates',  label: 'Groups'   },
  { id: 'sources',  label: 'Sources'  },
  { id: 'log',      label: 'Log'       },
] as const;

function scopeLabel(scope: import('../../types').WorkspaceScope | null): string {
  if (!scope) return '';
  if (scope.kind === 'solution') return pathUtils.fileName(scope.solutionPath);
  if (scope.kind === 'project' && scope.projectPath) return pathUtils.fileName(scope.projectPath);
  return '';
}

function ErrorBanner() {
  const { state, dispatch, send } = useNugetManager();
  const raw = state.globalError ?? 'Project file still has the new package version.';
  const nl = raw.indexOf('\n');
  const title = nl < 0 ? raw : raw.slice(0, nl);
  const body = nl < 0 ? '' : raw.slice(nl + 1).replace(/^\n+/, '');
  const extraLines = body.split('\n').filter((l) => l.trim().length > 0).length;
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => { setOpen(false); }, [raw]);

  return (
    <div className="error-banner error-banner--operation" role="alert">
      <div className="error-banner__head">
        {extraLines > 0 ? (
          <button
            type="button"
            className="error-banner__spoiler"
            aria-expanded={open}
            title={title}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              setOpen((v) => !v);
            }}
          >
            <span className="error-banner__title">{title}</span>
            <span className="error-banner__toggle">{open ? '▲' : `▼ ${extraLines}`}</span>
          </button>
        ) : (
          <span className="error-banner__title" title={title}>{title}</span>
        )}
        <div className="error-banner__actions">
          {state.pendingRollback && (
            <button
              type="button"
              className="error-banner__link"
              onClick={() => send({ type: 'ROLLBACK_FAILED_UPDATE' })}
            >
              Rollback
            </button>
          )}
          <button
            type="button"
            className="error-banner__link"
            onClick={() => dispatch({ type: 'SET_TAB', tab: 'updates' })}
          >
            Groups
          </button>
          <button
            type="button"
            className="error-banner__link"
            onClick={() => dispatch({ type: 'SET_TAB', tab: 'log' })}
          >
            Log
          </button>
          <button
            type="button"
            className="error-banner__dismiss"
            onClick={() => dispatch({ type: 'DISMISS_GLOBAL_ERROR' })}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      </div>
      {open && body ? (
        <div className="log-entry error-banner__log">
          <pre className="log-entry__body log-entry__body--stdout">{body}</pre>
        </div>
      ) : null}
    </div>
  );
}

function Shell() {
  const { state, dispatch, send } = useNugetManager();
  const label = scopeLabel(state.scope);
  const scopeTitle =
    state.scope?.kind === 'solution'
      ? state.scope.solutionPath
      : state.scope?.kind === 'project'
        ? state.scope.projectPath
        : 'Select a solution or project';

  if (state.dotnetMissing) {
    return (
      <div className="error-banner" role="alert">
        <strong>.NET SDK not found.</strong> Please install the .NET SDK and reload this panel.
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="tab-bar" role="tablist" aria-label="NuGet Manager tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={state.activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            className={`tab-btn${state.activeTab === tab.id ? ' tab-btn--active' : ''}`}
            onClick={() => dispatch({ type: 'SET_TAB', tab: tab.id })}
          >
            {tab.label}
          </button>
        ))}

        <button
          type="button"
          className="tab-bar__scope"
          title={scopeTitle || 'Select a solution or project'}
          onClick={() => send({ type: 'SELECT_SCOPE' })}
        >
          {state.scope?.kind === 'solution' ? '📦' : '📄'} {label || 'Select project…'}
        </button>
      </nav>

      {(state.globalError || state.pendingRollback) && (
        <ErrorBanner />
      )}

      <main className="tab-content">
        <div id="tabpanel-packages" role="tabpanel" hidden={state.activeTab !== 'packages'}>
          {state.activeTab === 'packages' && <PackagesTab />}
        </div>
        <div id="tabpanel-updates" role="tabpanel" hidden={state.activeTab !== 'updates'}>
          {state.activeTab === 'updates' && <UpdatesTab />}
        </div>
        <div id="tabpanel-sources" role="tabpanel" hidden={state.activeTab !== 'sources'}>
          {state.activeTab === 'sources' && <SourcesTab />}
        </div>
        <div id="tabpanel-log" role="tabpanel" hidden={state.activeTab !== 'log'}>
          {state.activeTab === 'log' && <LogTab />}
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <NugetManagerProvider>
      <Shell />
    </NugetManagerProvider>
  );
}
