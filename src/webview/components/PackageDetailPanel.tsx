import React, { useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { VersionSelector } from './VersionSelector';
import { ProjectSelectionPopup } from './ProjectSelectionPopup';
import { ProjectListSection } from './ProjectListSection';
import { CurrentDependenciesSection } from './CurrentDependenciesSection';
import { DetailHeader } from './DetailHeader';
import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { findingsAffectingPackage } from '../../vulnerabilities';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked } from '../../blockedPackages';
import type { VulnerabilityFinding } from '../../types';

export function PackageDetailPanel() {
  const { state, dispatch, send } = useNugetManager();
  const { selectedPackageId, metadata, allVersions, isLoading, error } = state.detail;
  const selectedDeps = selectedPackageId
    ? [...new Set(
      [...state.packages.installed, ...state.packages.implicit]
        .filter((p) => packageIdsEqual(p.id, selectedPackageId))
        .flatMap((p) => p.dependencies ?? []),
    )]
    : [];
  const { direct: directFindings, via: viaFindings } = selectedPackageId
    ? findingsAffectingPackage(state.packages.vulnerabilities, selectedPackageId, selectedDeps)
    : { direct: [] as VulnerabilityFinding[], via: [] as VulnerabilityFinding[] };
  const findings = [...directFindings, ...viaFindings];
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [showPopup, setShowPopup] = useState<'install' | 'remove' | null>(null);

  if (!selectedPackageId) {
    return <div className="detail-panel__empty">Select a package to see details</div>;
  }

  const scope = state.scope;
  const isSolution = scope?.kind === 'solution';
  const isInstalled = state.packages.installed.some((p) => packageIdsEqual(p.id, selectedPackageId));
  const updatesBlocked = isInstalled && isPackageBlocked(selectedPackageId, state.packages.blockedPackages);

  const effectiveVersion = selectedVersion || allVersions[0] || metadata?.version || '';

  const handleInstallUpdate = () => {
    if (!effectiveVersion || updatesBlocked) return;
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

  const currentVersions = (() => {
    const map: Record<string, string> = {};
    if (!isSolution || scope?.kind !== 'solution') return map;
    for (const p of scope.projects) {
      const inst = state.packages.installed.find((i) =>
        packageIdsEqual(i.id, selectedPackageId) && pathsEqual(i.projectPath, p.absolutePath),
      );
      if (inst) map[p.absolutePath] = inst.resolvedVersion;
    }
    return map;
  })();

  const handlePopupConfirm = (projects: string[]) => {
    if (showPopup === 'install' && updatesBlocked) {
      setShowPopup(null);
      return;
    }
    for (const p of projects) {
      dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
      dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    }
    if (showPopup === 'install') {
      send({ type: 'INSTALL_PACKAGE_MULTI', projects, packageId: selectedPackageId, version: effectiveVersion });
    } else if (showPopup === 'remove') {
      send({ type: 'REMOVE_PACKAGE_MULTI', projects, packageId: selectedPackageId });
    }
    setShowPopup(null);
  };

  return (
    <div className="detail-panel">
      <DetailHeader
        name={selectedPackageId}
        actions={isInstalled ? (
          <>
            <button
              className="btn btn--icon btn--primary"
              onClick={() => {
                if (updatesBlocked) {
                  send({
                    type: 'SHOW_TOAST',
                    message: `${selectedPackageId}: ${BLOCKED_UPDATES_TOOLTIP}`,
                  });
                  return;
                }
                handleInstallUpdate();
              }}
              disabled={isLoading}
              aria-disabled={updatesBlocked || undefined}
              title={updatesBlocked ? BLOCKED_UPDATES_TOOLTIP : 'Update to selected version'}
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
      >
        <VersionSelector
          packageId={selectedPackageId}
          versions={allVersions}
          selected={effectiveVersion}
          onChange={setSelectedVersion}
        />
      </DetailHeader>

      {(error || isLoading) && (
        <div className="detail-panel__status">
          {error && <span className="detail-panel__error" role="alert">{error}</span>}
          {isLoading && <span style={{ color: 'var(--color-tab-inactive)', fontSize: 11 }}>Loading…</span>}
        </div>
      )}

      {findings.length > 0 && (
        <div className="detail-section">
          <div className="detail-section__title">Vulnerabilities</div>
          <ul className="vuln-list">
            {findings.map((finding, index) => {
              const via = viaFindings.includes(finding) ? finding.packageId : undefined;
              return (
                <li
                  key={`${via ?? 'direct'}:${finding.source}:${finding.id ?? finding.url ?? index}`}
                  className={`vuln-item vuln-item--${finding.severity}${via ? ' vuln-item--via' : ''}`}
                >
                  <span className="vuln-item__sev">{finding.severity}</span>
                  <span className="vuln-item__body">
                    {via ? (
                      <>
                        <button
                          type="button"
                          className="vuln-item__via"
                          onClick={() => dispatch({ type: 'SELECT_PACKAGE', packageId: via })}
                          title={`Open ${via}`}
                        >
                          via {via}
                        </button>
                        {' · '}
                      </>
                    ) : null}
                    {finding.url ? (
                      <a href={finding.url} target="_blank" rel="noopener noreferrer">
                        {finding.id ?? finding.title ?? finding.url}
                      </a>
                    ) : (
                      finding.id ?? finding.title ?? 'Advisory'
                    )}
                    {finding.version ? ` · ${finding.version}` : ''}
                    {finding.source ? ` · ${finding.source}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
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

      <CurrentDependenciesSection packageId={selectedPackageId} />

      {/* ── Popup ── */}
      {showPopup && scope?.kind === 'solution' && (
        <ProjectSelectionPopup
          title={showPopup === 'install'
            ? `${isInstalled ? 'Update' : 'Install'} ${selectedPackageId} ${effectiveVersion}`
            : `Remove ${selectedPackageId}`}
          projects={
            showPopup === 'remove'
              ? scope.projects.filter((p) => p.absolutePath in currentVersions)
              : scope.projects
          }
          initiallySelected={
            showPopup === 'remove' || isInstalled
              ? Object.keys(currentVersions)
              : undefined
          }
          currentVersions={currentVersions}
          targetVersion={showPopup === 'install' ? effectiveVersion : undefined}
          onConfirm={handlePopupConfirm}
          onCancel={() => setShowPopup(null)}
        />
      )}
    </div>
  );
}
