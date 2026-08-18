import React from 'react';
import { NugetManagerProvider, useNugetManager } from './context/NugetManagerContext';
import { PackagesTab } from './components/PackagesTab';
import { SourcesTab } from './components/SourcesTab';
import { LogTab } from './components/LogTab';
import * as pathUtils from './utils/pathUtils';

const TABS = [
  { id: 'packages', label: 'Packages' },
  { id: 'sources',  label: 'Sources'  },
  { id: 'log',      label: 'Log'       },
] as const;

function scopeLabel(scope: import('../../types').WorkspaceScope | null): string {
  if (!scope) return '';
  if (scope.kind === 'solution') return pathUtils.fileName(scope.solutionPath);
  if (scope.kind === 'project' && scope.projectPath) return pathUtils.fileName(scope.projectPath);
  return '';
}

function Shell() {
  const { state, dispatch } = useNugetManager();
  const label = scopeLabel(state.scope);

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

        {label && (
          <span className="tab-bar__scope" title={
            state.scope?.kind === 'solution'
              ? (state.scope as any).solutionPath
              : (state.scope as any).projectPath
          }>
            {state.scope?.kind === 'solution' ? '📦' : '📄'} {label}
          </span>
        )}
      </nav>

      <main className="tab-content">
        <div id="tabpanel-packages" role="tabpanel" hidden={state.activeTab !== 'packages'}>
          {state.activeTab === 'packages' && <PackagesTab />}
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
