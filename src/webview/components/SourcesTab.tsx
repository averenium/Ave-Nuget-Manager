import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

export function SourcesTab() {
  const { state, send } = useNugetManager();
  const { configChain } = state.sources;

  const hasAnySources = configChain.some((c) => c.sources.length > 0);

  if (configChain.length === 0) {
    return (
      <div className="sources-tab">
        <div className="empty-state">No nuget.config files found in the chain</div>
      </div>
    );
  }

  // Track which source names we've already shown (nearest config wins)
  const shownSourceNames = new Set<string>();

  return (
    <div className="sources-tab" role="region" aria-label="NuGet source configuration">
      {!hasAnySources && (
        <div className="empty-state" style={{ marginBottom: 'var(--spacing-md)' }}>
          No package sources configured
        </div>
      )}

      {state.packages.vulnHint?.show && (
        <div className="config-file__hint">
          {state.packages.vulnHint.message}
          {state.packages.vulnHint.configFilePath && (
            <>
              {' '}
              <button
                type="button"
                className="config-file__path-btn"
                onClick={() => send({
                  type: 'OPEN_CONFIG_FILE',
                  filePath: state.packages.vulnHint!.configFilePath!,
                })}
              >
                Open nuget.config
              </button>
            </>
          )}
        </div>
      )}

      {configChain.map((configFile) => {
        // Only show sources not already shown by a nearer config
        const uniqueSources = configFile.sources.filter((src) => {
          const key = src.name.toLowerCase();
          if (shownSourceNames.has(key)) return false;
          shownSourceNames.add(key);
          return true;
        });

        return (
          <div key={configFile.filePath} className="config-file">
            <button
              className="config-file__path-btn"
              onClick={() => send({ type: 'OPEN_CONFIG_FILE', filePath: configFile.filePath })}
              title={`Open ${configFile.filePath}`}
              aria-label={`Open ${configFile.filePath}`}
            >
              📄 {configFile.filePath}
            </button>

            {configFile.parseError && (
              <div className="config-file__warning" role="alert">
                ⚠ Could not parse: {configFile.parseError}
              </div>
            )}

            {uniqueSources.length > 0 && (
              <div style={{ marginTop: 'var(--spacing-xs)' }}>
                {uniqueSources.map((src) => (
                  <div key={src.name} className="source-item">
                    <span
                      className={`source-item__badge source-item__badge--${src.enabled ? 'enabled' : 'disabled'}`}
                    >
                      {src.enabled ? 'ON' : 'OFF'}
                    </span>
                    <strong style={{ fontSize: 12 }}>{src.name}</strong>
                    <span className="source-item__url">{src.url}</span>
                  </div>
                ))}
              </div>
            )}

            {uniqueSources.length === 0 && !configFile.parseError && configFile.sources.length > 0 && (
              <div style={{ color: 'var(--color-tab-inactive)', fontSize: 12, marginTop: 4 }}>
                All sources in this file are already defined in a nearer config
              </div>
            )}

            {uniqueSources.length === 0 && !configFile.parseError && configFile.sources.length === 0 && (
              <div style={{ color: 'var(--color-tab-inactive)', fontSize: 12, marginTop: 4 }}>
                No sources defined in this file
              </div>
            )}

            <div className="audit-sources">
              <div className="audit-sources__label">auditSources</div>
              {(configFile.auditSources ?? []).length === 0 ? (
                <div className="audit-sources__none">none</div>
              ) : (configFile.auditSources ?? []).map((src) => (
                <div key={src.name} className="source-item">
                  <strong style={{ fontSize: 12 }}>{src.name}</strong>
                  <span className="source-item__url">{src.url}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
