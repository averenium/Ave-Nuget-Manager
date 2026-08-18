import React, { useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { VersionSelector } from './VersionSelector';
import { ProjectSelectionPopup } from './ProjectSelectionPopup';
import { ProjectListSection } from './ProjectListSection';

export function PackageDetailPanel() {
  const { state, dispatch, send } = useNugetManager();
  const { selectedPackageId, metadata, allVersions, isLoading, error } = state.detail;
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [showPopup, setShowPopup] = useState<'install' | 'remove' | null>(null);

  if (!selectedPackageId) {
    return <div className="detail-panel__empty">Select a package to see details</div>;
  }

  const scope = state.scope;
  const isSolution = scope?.kind === 'solution';
  const isInstalled = state.packages.installed.some((p) => p.id === selectedPackageId);

  const effectiveVersion = selectedVersion || allVersions[0] || metadata?.version || '';

  const handleInstallUpdate = () => {
    if (!effectiveVersion) return;
    if (isSolution) {
      setShowPopup('install');
    } else if (scope?.kind === 'project') {
      send({ type: 'INSTALL_PACKAGE', projectPath: scope.projectPath, packageId: selectedPackageId, version: effectiveVersion });
    }
  };

  const handleRemove = () => {
    if (isSolution) {
      setShowPopup('remove');
    } else if (scope?.kind === 'project') {
      send({ type: 'REMOVE_PACKAGE', projectPath: scope.projectPath, packageId: selectedPackageId });
    }
  };

  const handlePopupConfirm = (projects: string[]) => {
    if (showPopup === 'install') {
      send({ type: 'INSTALL_PACKAGE_MULTI', projects, packageId: selectedPackageId, version: effectiveVersion });
    } else if (showPopup === 'remove') {
      send({ type: 'REMOVE_PACKAGE_MULTI', projects, packageId: selectedPackageId });
    }
    setShowPopup(null);
  };

  return (
    <div className="detail-panel">
      {/* ── Section 1: package name + version + actions — one row ── */}
      <div className="detail-header">
        <span className="detail-header__name" title={selectedPackageId}>
          {selectedPackageId}
        </span>

        <VersionSelector
          packageId={selectedPackageId}
          versions={allVersions}
          selected={effectiveVersion}
          onChange={setSelectedVersion}
        />

        <div className="detail-header__actions">
          {isInstalled ? (
            <>
              <button
                className="btn btn--icon btn--primary"
                onClick={handleInstallUpdate}
                disabled={isLoading}
                title="Update to selected version"
                aria-label="Update"
              >↑</button>
              <button
                className="btn btn--icon btn--danger"
                onClick={handleRemove}
                disabled={isLoading}
                title="Remove package"
                aria-label="Remove"
              >✕</button>
            </>
          ) : (
            <button
              className="btn btn--icon btn--primary"
              onClick={handleInstallUpdate}
              disabled={isLoading}
              title="Install selected version"
              aria-label="Install"
            >↓</button>
          )}
        </div>
      </div>

      {(error || isLoading) && (
        <div className="detail-panel__status">
          {error && <span className="detail-panel__error" role="alert">{error}</span>}
          {isLoading && <span style={{ color: 'var(--color-tab-inactive)', fontSize: 11 }}>Loading…</span>}
        </div>
      )}

      {/* ── Section 2: Metadata ── */}
      {metadata && (
        <div className="detail-section">
          <div className="detail-section__title">Info</div>
          <dl className="metadata-grid">
            {metadata.authors && (
              <>
                <dt>Authors</dt>
                <dd>{metadata.authors}</dd>
              </>
            )}
            {metadata.description && (
              <>
                <dt>Description</dt>
                <dd>{metadata.description}</dd>
              </>
            )}
            {metadata.projectUrl && (
              <>
                <dt>Project</dt>
                <dd><a href={metadata.projectUrl} target="_blank" rel="noopener noreferrer">{metadata.projectUrl}</a></dd>
              </>
            )}
            {metadata.licenseUrl && (
              <>
                <dt>License</dt>
                <dd><a href={metadata.licenseUrl} target="_blank" rel="noopener noreferrer">{metadata.licenseUrl}</a></dd>
              </>
            )}
            {metadata.published && (
              <>
                <dt>Published</dt>
                <dd>{new Date(metadata.published).toLocaleDateString()}</dd>
              </>
            )}
          </dl>

          {metadata.tags.length > 0 && (
            <div className="tag-list" aria-label="Tags">
              {metadata.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            </div>
          )}

          {metadata.targetFrameworks.length > 0 && (
            <div>
              <div className="detail-section__title" style={{ marginBottom: 4 }}>Target Frameworks</div>
              <div className="tag-list">
                {metadata.targetFrameworks.map((f) => <span key={f} className="tag">{f}</span>)}
              </div>
            </div>
          )}

          {metadata.dependencies.length > 0 && (
            <div>
              <div className="detail-section__title" style={{ marginBottom: 4 }}>Dependencies</div>
              {metadata.dependencies.map((group) => (
                <div key={group.framework} className="dependency-group">
                  <div className="dependency-group__title">{group.framework}</div>
                  {group.packages.map((dep) => (
                    <div key={dep.id} className="dependency-row">
                      <span>{dep.id}</span>
                      <span style={{ color: 'var(--color-tab-inactive)' }}>{dep.versionRange}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Section 3: Projects (solution scope only) ── */}
      {isSolution && scope?.kind === 'solution' && (
        <div className="detail-section">
          <div className="detail-section__title">Projects</div>
          <ProjectListSection
            packageId={selectedPackageId}
            projects={scope.projects}
            installed={state.packages.installed}
            allVersions={allVersions}
          />
        </div>
      )}

      {/* ── Popup ── */}
      {showPopup && scope?.kind === 'solution' && (
        <ProjectSelectionPopup
          title={showPopup === 'install'
            ? `Install ${selectedPackageId} ${effectiveVersion}`
            : `Remove ${selectedPackageId}`}
          projects={
            showPopup === 'remove'
              ? scope.projects.filter((p) =>
                  state.packages.installed.some((i) => i.id === selectedPackageId && i.projectPath === p.absolutePath)
                )
              : scope.projects
          }
          onConfirm={handlePopupConfirm}
          onCancel={() => setShowPopup(null)}
        />
      )}
    </div>
  );
}
