import React from 'react';
import { NugetManagerProvider, useNugetManager } from './context/NugetManagerContext';
import { PackagesTab } from './components/PackagesTab';
import { SourcesTab } from './components/SourcesTab';
import { UpdatesTab } from './components/UpdatesTab';
import { LogTab } from './components/LogTab';
import { AgentsTab } from './components/AgentsTab';
import { ScopeChooserBody } from './components/ScopeChooserBody';
import type { ScopePickTarget } from './components/ScopeChooser';
import { scopeLabel, scopeIcon, scopeIdentityPath, scopeChooserRenderState } from './utils/scope';
import { snapshotNeedsSourcesWarn } from '../vulnerabilityScanPolicy';
import type { SourcesSnapshot } from '../types';

const TABS = [
  { id: 'packages', label: 'Packages' },
  { id: 'updates',  label: 'Groups'   },
  { id: 'sources',  label: 'Sources'  },
  { id: 'log',      label: 'Log'     },
  { id: 'agents',   label: 'Agents'  },
] as const;

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

function sourcesTabNeedsWarn(snapshot: SourcesSnapshot | null): boolean {
  try {
    return snapshotNeedsSourcesWarn(snapshot);
  } catch {
    return false;
  }
}

function Shell() {
  const { state, dispatch, send } = useNugetManager();
  const label = scopeLabel(state.scope);
  const sourcesWarn = sourcesTabNeedsWarn(state.sources.snapshot);
  const scopeTitle =
    state.scope?.kind === 'solution'
      ? state.scope.solutionPath
      : state.scope?.kind === 'folder'
        ? state.scope.folderPath
        : state.scope?.kind === 'project'
          ? state.scope.projectPath
          : 'Select a solution or project';

  const { scope, scopeChoices } = state;
  // The Packages tab hosts its own chooser — unprompted while the folder is
  // still ambiguous, or reopened on that same tab (#113). Every other tab
  // has no ambient state of its own to show; this only ever applies once the
  // corner control is actually pressed from one of them (#129).
  const chooser = scopeChooserRenderState(scope, !!scopeChoices, state.scopeChooserOpen, state.activeTab);

  const pickScope = (target: ScopePickTarget) => {
    if (!scopeChoices) return;
    if (target.kind === 'folder') {
      send({ type: 'PICK_SCOPE_FOLDER', folderPath: scopeChoices.folderPath });
    } else {
      send({ type: 'PICK_SCOPE', path: target.path });
    }
  };

  // Reopened over whichever non-Packages tab was active when the corner
  // control was pressed (#129) — computed once and swapped in for that tab's
  // own body below, rather than repeating the same block four times.
  const reopenedChooser = chooser.visible && scopeChoices ? (
    <ScopeChooserBody
      choices={scopeChoices}
      currentPath={chooser.showCurrent ? scopeIdentityPath(scope) : null}
      currentLabel={chooser.showCurrent ? label : ''}
      tight={chooser.tight}
      showBackdrop={chooser.showBackdrop}
      onPick={pickScope}
      onClose={() => dispatch({ type: 'CLOSE_SCOPE_CHOOSER' })}
    />
  ) : null;

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
            {tab.id === 'sources' && sourcesWarn ? (
              <span className="tab-btn__warn" title="Effective config has no working audit source">⚠</span>
            ) : null}
          </button>
        ))}

        <button
          type="button"
          className={
            `tab-bar__scope${!state.scope || state.scopeChooserOpen ? ' tab-bar__scope--action' : ''}`
          }
          title={scopeTitle || 'Select a solution or project'}
          onClick={() => {
            // Same button opened it — pressing it again closes it (#113),
            // regardless of whether a scope exists yet to go back to: an
            // ambiguous folder is not an exception (#129). Only the
            // unprompted, never-pressed chooser has no closed state to
            // return to.
            if (state.scopeChooserOpen) {
              dispatch({ type: 'CLOSE_SCOPE_CHOOSER' });
            } else {
              send({ type: 'SELECT_SCOPE' });
            }
          }}
        >
          {state.scope
            ? <>{scopeIcon(state.scope)} {label} ▾</>
            : '▤ Solution or project…'}
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
          {state.activeTab === 'updates' && (reopenedChooser ?? <UpdatesTab />)}
        </div>
        <div id="tabpanel-sources" role="tabpanel" hidden={state.activeTab !== 'sources'}>
          {state.activeTab === 'sources' && (reopenedChooser ?? <SourcesTab />)}
        </div>
        <div id="tabpanel-log" role="tabpanel" hidden={state.activeTab !== 'log'}>
          {state.activeTab === 'log' && (reopenedChooser ?? <LogTab />)}
        </div>
        <div id="tabpanel-agents" role="tabpanel" hidden={state.activeTab !== 'agents'}>
          {state.activeTab === 'agents' && (reopenedChooser ?? <AgentsTab />)}
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
