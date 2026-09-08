import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { VersionSelector } from './VersionSelector';
import { ProjectSelectionPopup } from './ProjectSelectionPopup';
import { ProjectListSection } from './ProjectListSection';
import { PackageAttributeColumn } from './PackageAttributeColumn';
import { PackageDependenciesSection } from './PackageDependenciesSection';
import { DetailHeader } from './DetailHeader';
import { RoslynCapPopup } from './RoslynCapPopup';
import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { findingsAffectingPackage } from '../../vulnerabilities';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked } from '../../blockedPackages';
import { compareSemVer } from '../../semver';
import { needsRoslynUpgradeConfirm } from '../../roslynSdkCap';
import { versionTone } from '../utils/versionTone';
import { IconTrash } from '../utils/icons';
import { buildPackageProblems } from '../utils/packageProblems';
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
  const [showRoslynWarning, setShowRoslynWarning] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const descRef = useRef<HTMLDivElement>(null);
  const [descClamped, setDescClamped] = useState(false);

  // A version picked for the previously selected package must not leak into
  // a newly selected one — `effectiveVersion` checks `selectedVersion` first,
  // so without this reset it would win over the new package's own latest (#59).
  useEffect(() => {
    setSelectedVersion('');
    setDescExpanded(false);
  }, [selectedPackageId]);

  // "more" only appears when the two-line clamp actually hides something.
  // Whether it does depends on the pane width and the theme's font, so it is
  // measured rather than assumed — hence the observer, which watches just this
  // one element. Skipped while expanded: there scrollHeight equals clientHeight
  // and the toggle would take itself away instead of offering "less".
  //
  // Deliberately not reset when the selection changes: a reset lands after the
  // paint, so the row would blink out and back in on every package switch. The
  // measurement below runs before the next paint instead, and simply overwrites.
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el || descExpanded) return;
    const check = () => setDescClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [metadata?.description, descExpanded]);

  if (!selectedPackageId) {
    return <div className="detail-panel__empty">Select a package to see details</div>;
  }

  const scope = state.scope;
  /** Solution/folder scopes list multiple projects and need the project-picker popup. */
  const isMultiProject = scope?.kind === 'solution' || scope?.kind === 'folder';
  const isInstalled = state.packages.installed.some((p) => packageIdsEqual(p.id, selectedPackageId));
  const updatesBlocked = isInstalled && isPackageBlocked(selectedPackageId, state.packages.blockedPackages);

  const effectiveVersion = selectedVersion || allVersions[0] || metadata?.version || '';
  const installedEntries = state.packages.installed.filter((p) => packageIdsEqual(p.id, selectedPackageId));
  const installedVersions = installedEntries.map((p) => p.resolvedVersion);
  const installedFrom = installedVersions[0] ?? '';
  // The local .nuspec and the restore graph (#86) are readable for anything the
  // restore put on disk, and a transitive package's folder and its entry in
  // project.assets.json are as present as a direct one's. Deliberately not
  // folded into `installedEntries`, which decides what the action buttons and
  // the Roslyn cap do and has to stay direct-only.
  const restoredEntry = installedEntries[0]
    ?? state.packages.implicit.find((p) => packageIdsEqual(p.id, selectedPackageId));
  // Only meaningful once installed — Install (not yet installed) has no
  // "from" version to compare against, so it keeps its own glyph (#55).
  const updateTone = isInstalled ? versionTone(installedFrom, effectiveVersion) : undefined;
  const updateGlyph = updateTone === 'down' ? '↓' : updateTone === 'same' ? '=' : '↑';
  const updateTitle = updatesBlocked
    ? BLOCKED_UPDATES_TOOLTIP
    : updateTone === 'down'
      ? 'Downgrade to selected version'
      : updateTone === 'same'
        ? 'Reinstall selected version'
        : 'Update to selected version';

  // ── Problems: vulnerabilities + any other condition worth explaining, not
  // just a row-mark tooltip (#57). `buildPackageProblems` holds the decision
  // logic (which problems apply, with what tone) so it's testable without
  // rendering; JSX bodies are built here from its plain-data descriptors.
  const packageSourceMapping = state.sources.snapshot?.packageSourceMapping ?? [];
  const problems = buildPackageProblems({
    packageId: selectedPackageId,
    findings,
    viaFindings,
    isInstalled,
    packageSourceMapping,
    updatesBlocked,
    deprecation: metadata?.deprecation,
  });

  // Metadata arrives a moment after the selection does. Sections that don't
  // depend on it must not paint in that gap, or they land in their final place
  // only to be pushed down when the Info section is inserted above them.
  const metadataSettled = metadata !== null || error !== null;

  const proceedInstall = () => {
    if (!effectiveVersion || updatesBlocked) return;
    if (isMultiProject) {
      setShowPopup('install');
    } else if (scope?.kind === 'project') {
      send({ type: 'INSTALL_PACKAGE', projectPath: scope.projectPath, packageId: selectedPackageId, version: effectiveVersion });
    }
  };

  const handleInstallUpdate = () => {
    if (!effectiveVersion || updatesBlocked) return;
    if (needsRoslynUpgradeConfirm({
      packageId: selectedPackageId,
      chosenVersion: effectiveVersion,
      installedVersions,
      cap: state.roslynCap,
    })) {
      setShowRoslynWarning(true);
      return;
    }
    proceedInstall();
  };

  const handleRemove = () => {
    if (isMultiProject) {
      setShowPopup('remove');
    } else if (scope?.kind === 'project') {
      send({ type: 'REMOVE_PACKAGE', projectPath: scope.projectPath, packageId: selectedPackageId });
    }
  };

  const currentVersions = (() => {
    const map: Record<string, string> = {};
    if (!scope || (scope.kind !== 'solution' && scope.kind !== 'folder')) return map;
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
              className={`btn btn--icon ${updateTone === 'same' ? 'btn--secondary' : 'btn--primary'}`}
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
              title={updateTitle}
              aria-label="Update"
            >{updateGlyph}</button>
            <button
              className="btn btn--icon pkg-remove-btn"
              onClick={handleRemove}
              disabled={isLoading}
              title="Remove package"
              aria-label="Remove"
            ><IconTrash /></button>
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
          restoredVersion={restoredEntry?.resolvedVersion ?? ''}
          restoredProjectPath={restoredEntry?.projectPath ?? ''}
        />
      </DetailHeader>

      {(error || isLoading || !metadataSettled) && (
        <div className="detail-panel__status">
          {error && <span className="detail-panel__error" role="alert">{error}</span>}
          {(isLoading || !metadataSettled) && (
            <span style={{ color: 'var(--color-tab-inactive)', fontSize: 11 }}>Loading…</span>
          )}
        </div>
      )}

      {/* ── Description + Problems (left) / attribute column (right) ── */}
      {metadata && (
        <div className="detail-section pkg-info">
          <div className="pkg-info__main">
            {metadata.description && (
              <>
                <div
                  ref={descRef}
                  className={descExpanded ? 'pkg-info__desc pkg-info__desc--expanded' : 'pkg-info__desc'}
                >
                  {metadata.description}
                </div>
                {(descClamped || metadata.authors) && (
                  <div className="pkg-info__sub">
                    {descClamped && (
                      <button
                        type="button"
                        className="pkg-info__more"
                        onClick={() => setDescExpanded(!descExpanded)}
                      >{descExpanded ? 'less' : 'more'}</button>
                    )}
                    {metadata.authors && (
                      <span className="pkg-info__authors" title={metadata.authors}>
                        {descClamped ? '· ' : ''}{metadata.authors}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}

            {problems.length > 0 && (
              <div className="problems-band">
                <div className="detail-section__title">Problems</div>
                <ul className="vuln-list">
                  {problems.map((p) => {
                    const via = p.kind === 'vulnerability' ? p.via : undefined;
                    return (
                    <li key={p.key} className={`vuln-item vuln-item--${p.tone}${via ? ' vuln-item--via' : ''}`}>
                      <span className="vuln-item__sev">{p.label}</span>
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
                        {p.kind === 'vulnerability' ? (
                          <>
                            {p.finding.url ? (
                              <a href={p.finding.url} target="_blank" rel="noopener noreferrer">
                                {p.finding.id ?? p.finding.title ?? p.finding.url}
                              </a>
                            ) : (
                              p.finding.id ?? p.finding.title ?? 'Advisory'
                            )}
                            {p.finding.version ? ` · ${p.finding.version}` : ''}
                            {p.finding.source ? ` · ${p.finding.source}` : ''}
                          </>
                        ) : p.kind === 'mapping' ? (
                          <>
                            No <code>packageSourceMapping</code> pattern matches <strong>{selectedPackageId}</strong> — restore
                            will not be able to find it.
                            {' '}Mapped sources: {p.mappedSourceNames.join(', ')}.
                          </>
                        ) : p.kind === 'deprecation' ? (
                          p.message
                        ) : (
                          <>
                            Updates are blocked for this package in this workspace. Right-click the row and choose{' '}
                            <strong>Unblock updates</strong> to allow a version change.
                          </>
                        )}
                      </span>
                    </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <PackageAttributeColumn
            license={metadata.license}
            licenseUrl={metadata.licenseUrl}
            projectUrl={metadata.projectUrl}
            repository={metadata.repository}
            supportedFrameworks={metadata.supportedFrameworks}
            runtimeIdentifiers={metadata.runtimeIdentifiers}
          />
        </div>
      )}

      {/* ── Section 3: Projects (solution/folder scope only) ── */}
      {metadataSettled && isMultiProject && scope && (scope.kind === 'solution' || scope.kind === 'folder') && (
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

      {metadata?.dependencyTree && <PackageDependenciesSection info={metadata.dependencyTree} />}

      {/* ── Popup ── */}
      {showRoslynWarning && state.roslynCap && (
        <RoslynCapPopup
          packageId={selectedPackageId}
          fromVersion={installedFrom}
          toVersion={effectiveVersion}
          cap={state.roslynCap}
          onConfirm={() => {
            setShowRoslynWarning(false);
            proceedInstall();
          }}
          onCancel={() => setShowRoslynWarning(false)}
        />
      )}
      {showPopup && scope && (scope.kind === 'solution' || scope.kind === 'folder') && (
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
            showPopup === 'remove'
              ? Object.keys(currentVersions)
              : isInstalled
                ? Object.keys(currentVersions).filter(
                  (p) => compareSemVer(currentVersions[p], effectiveVersion) !== 0,
                )
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
