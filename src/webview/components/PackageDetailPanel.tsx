import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { searchableConfigFiles } from '../../searchConfigFiles';
import { fileNameNoExt } from '../utils/pathUtils';
import { VersionSelector } from './VersionSelector';
import { ProjectSelectionPopup } from './ProjectSelectionPopup';
import { ProjectListSection } from './ProjectListSection';
import { PackageAttributeColumn } from './PackageAttributeColumn';
import { PackageDependenciesSection } from './PackageDependenciesSection';
import { DeclaredDependenciesSection } from './DeclaredDependenciesSection';
import { DetailHeader } from './DetailHeader';
import { OperationProgressStrip } from './OperationProgressStrip';
import { RoslynCapPopup } from './RoslynCapPopup';
import { CrossLinePopup } from './CrossLinePopup';
import { SplitReferencePopup } from './SplitReferencePopup';
import { narrowingSplitsReference, pinsCrossedBy } from '../../frameworkPins';
import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { findingsAffectingPackage } from '../../vulnerabilities';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked } from '../../blockedPackages';
import { compareSemVer, versionsEqual } from '../../semver';
import { needsRoslynUpgradeConfirm } from '../../roslynSdkCap';
import { versionTone } from '../utils/versionTone';
import { IconCheck, IconInstall, IconTrash } from '../utils/icons';
import { buildPackageProblems } from '../utils/packageProblems';
import { resolveVersionSpread } from '../../packageResolvedVersions';
import { LicenseSideText } from './LicenseSideText';
import { VersionChangesBand } from './VersionChangesBand';
import { sortTargetFrameworksDesc } from '../../targetFrameworks';
import { nearestUnaffectedVersion } from '../utils/nearestUnaffected';
import { flagsForVersion } from '../utils/versionFlags';
import type { VulnerabilityFinding } from '../../types';

/** How long the version selection has to hold still before the question goes out (#89, #114). */
const VERSION_DIFF_DEBOUNCE_MS = 500;

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
  /**
   * A per-package update that would take a framework out of its pinned major
   * line waits here until the user says yes (#82). Batch updates never reach
   * this: they stay inside each line by construction.
   */
  const [crossLine, setCrossLine] = useState<{
    projects: string[];
    frameworks: Array<{ framework: string; version: string }>;
    frameworksByProject?: Record<string, string[]>;
  } | null>(null);
  /**
   * A narrowing that has to rebuild a project's single reference into one group
   * per framework waits here until the user says yes (#82). The shape of the
   * project file changes, which is more than the version change they asked for.
   */
  const [splitConfirm, setSplitConfirm] = useState<{
    projects: string[];
    frameworksByProject: Record<string, string[]>;
    splitting: Array<{ name: string; frameworks: string[] }>;
  } | null>(null);

  // A version picked for the previously selected package must not leak into
  // a newly selected one — `effectiveVersion` checks `selectedVersion` first,
  // so without this reset it would win over the new package's own latest (#59).
  useEffect(() => {
    setSelectedVersion('');
    setDescExpanded(false);
  }, [selectedPackageId]);

  // What was selected, and how the panel reads it. `installed` here is the
  // panel's own answer, not the list's — when the two disagree the log is the
  // only place that shows it, and that disagreement is exactly what once made a
  // package look absent from a list that held it.
  useEffect(() => {
    if (!selectedPackageId) return;
    send({
      type: 'WEBVIEW_ACTION',
      action: 'select',
      packageId: selectedPackageId,
      version: selectedVersion || allVersions[0] || metadata?.version || undefined,
      counts: {
        installed: [
          state.packages.installed.filter((p) => packageIdsEqual(p.id, selectedPackageId)).length,
          state.packages.installed.length,
        ],
        implicit: [
          state.packages.implicit.filter((p) => packageIdsEqual(p.id, selectedPackageId)).length,
          state.packages.implicit.length,
        ],
        available: state.packages.available.length,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPackageId]);

  // The licence question is about the version the selector is offering, which
  // on entry is the newest rather than the installed one — so it cannot ride on
  // the metadata request, which asks about the installed version. Re-asked
  // whenever that offer changes, including on returning to a package.
  useEffect(() => {
    const configFiles = searchableConfigFiles(state.sources.configChain);
    // The same expression `effectiveVersion` uses below; it cannot be read here
    // because hooks run before the early return that guards it.
    const offered = selectedVersion || allVersions[0] || metadata?.version || '';
    if (!selectedPackageId || !offered || configFiles.length === 0) return;
    // What was asked about lives in state rather than a ref, so it clears with
    // the package: a ref survives the switch, and coming back to a package
    // whose answer `SELECT_PACKAGE` had just cleared would look like it had
    // already been asked and leave the row permanently absent.
    if (state.detail.versionDiff?.version === offered) return;
    // Held back until the selection settles. Arrowing through a version list
    // passes every version on the way, and a version whose licence expression
    // the feed leaves empty costs a nuspec request each — so the ones merely
    // scrolled past are never asked about at all. The broker cancels whatever is still
    // in flight on the next question; this stops most of them being asked.
    // Same device as the package search in `PackagesTab`, one notch longer
    // because a keypress here is a step in a list rather than a letter.
    const timer = setTimeout(() => {
      // Recorded before the request goes out: answers come back out of order
      // when the version list is scrolled, and the reducer matches each against
      // the version still being asked about rather than letting a late one take
      // its place.
      dispatch({ type: 'ASK_VERSION_DIFF', version: offered });
      send({ type: 'GET_VERSION_DIFF', packageId: selectedPackageId, version: offered, configFiles });
    }, VERSION_DIFF_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPackageId, selectedVersion, allVersions, metadata?.version, state.sources.configChain]);

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
  // The local .nuspec and the restore graph (#86) are readable for anything the
  // restore put on disk, and a transitive package's folder and its entry in
  // project.assets.json are as present as a direct one's. Deliberately not
  // folded into `installedEntries`, which decides what the action buttons and
  // the Roslyn cap do and has to stay direct-only.
  const implicitEntries = state.packages.implicit.filter((p) => packageIdsEqual(p.id, selectedPackageId));
  const spread = resolveVersionSpread(installedEntries, implicitEntries);
  /**
   * The version this panel says the package is on, which a solution resolves per
   * project — so the entry the CLI happened to list first is not it (#90, #115).
   *
   * The host already compares from the spread's primary; taking the first entry
   * here made the "what changes" band name one version while the comparison had
   * been made from another, and the update button's glyph and tooltip were
   * pointed at the wrong version in the same way, from before #114.
   */
  const installedFrom = spread?.primary ?? installedVersions[0] ?? '';
  const restoredEntry = [...installedEntries, ...implicitEntries]
    .find((p) => p.resolvedVersion === spread?.primary);
  // Only meaningful once installed — Install (not yet installed) has no
  // "from" version to compare against, so it keeps its own glyph (#55).
  // The version walk the picker already made carries a date per version, so the
  // column answers for whatever version is picked without waiting for a
  // metadata round trip of its own (#114). `metadata.published` is the
  // authority when it is about the version on screen.
  const publishedOfSelected = metadata?.version && metadata.published
    && versionsEqual(metadata.version, effectiveVersion)
    ? metadata.published
    : flagsForVersion(state.detail.versionFlags, effectiveVersion)?.published;

  // Newest first, so the framework a declared-dependency group is looked up for
  // is the one the workspace is most likely to care about.
  const workspaceFrameworks = sortTargetFrameworksDesc(
    [...new Set(Object.values(state.packages.projectFrameworks).flat())],
  );

  // Only the answer about the version on screen; one about a version the reader
  // has since moved away from describes a comparison they are no longer looking
  // at. The licence half of the same answer is read the same way, below.
  const versionChanges = state.detail.versionDiff?.version
    && versionsEqual(state.detail.versionDiff.version, effectiveVersion)
    ? state.detail.versionDiff.dependencies ?? undefined
    : undefined;

  const nearestClean = nearestUnaffectedVersion(
    allVersions, state.detail.versionFlags, effectiveVersion,
  );

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
    // An installed package's Info panel is built from its local `.nuspec`,
    // which cannot carry a deprecation: that is a fact about the feed, not
    // about the package. The feed's answer is already here, keyed by version —
    // it is what marks the version dropdown — so the panel reads it from there
    // when the nuspec has nothing to say. Keyed by the version the panel is
    // actually showing, which for a nuspec is the installed one.
    deprecation: metadata?.deprecation
      ?? flagsForVersion(state.detail.versionFlags, metadata?.version ?? effectiveVersion)?.deprecation,
    // The one fact a local `.nuspec` cannot state about itself: whether the
    // feed still lists it. Asked about the version actually installed, never
    // the one being browsed for an update (#114).
    unlistedInstalledVersion: isInstalled && installedFrom
      && flagsForVersion(state.detail.versionFlags, installedFrom)?.listed === false
      ? installedFrom
      : undefined,
    // Only the answer about the version on screen. One about a version the
    // user has since moved away from describes a comparison they are no longer
    // looking at.
    licenseChange: state.detail.versionDiff?.version
      && versionsEqual(state.detail.versionDiff.version, effectiveVersion)
      ? state.detail.versionDiff.license ?? undefined
      : undefined,
    // What the feed says about the version the user is looking at, which the
    // restore-graph scan cannot know: it only ever describes what is installed.
    selectedVersion: effectiveVersion,
    selectedVersionAdvisories: flagsForVersion(state.detail.versionFlags, effectiveVersion)?.advisories,
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
      // One project has no per-project rows to watch, so the operation reports
      // itself here instead — before this it ran with no feedback at all, the
      // panel's "Loading…" being about metadata rather than the install (#104).
      const crossed = pinsCrossedBy(
        state.packages.installed, selectedPackageId, [scope.projectPath], effectiveVersion,
      );
      if (crossed.length > 0) {
        setCrossLine({ projects: [scope.projectPath], frameworks: crossed });
        return;
      }
      startInstall([scope.projectPath]);
    }
  };

  /** Sends the install itself, once every question has been answered. */
  const startInstall = (
    projects: string[],
    frameworksByProject?: Record<string, string[]>,
    acrossLines?: boolean,
  ) => {
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'install', total: projects.length });
    for (const p of projects) {
      dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
      dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    }
    if (projects.length === 1 && !isMultiProject) {
      send({
        type: 'INSTALL_PACKAGE',
        projectPath: projects[0],
        packageId: selectedPackageId,
        version: effectiveVersion,
        acrossLines,
      });
      return;
    }
    send({
      type: 'INSTALL_PACKAGE_MULTI',
      projects,
      packageId: selectedPackageId,
      version: effectiveVersion,
      frameworks: frameworksByProject,
      acrossLines,
    });
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
      dispatch({ type: 'START_PROJECT_OPERATION', operation: 'remove', total: 1 });
      send({ type: 'REMOVE_PACKAGE', projectPath: scope.projectPath, packageId: selectedPackageId });
    }
  };

  const currentVersions = (() => {
    const map: Record<string, string> = {};
    if (!scope || (scope.kind !== 'solution' && scope.kind !== 'folder')) return map;
    for (const p of scope.projects) {
      // A project pinning this package per target framework has several entries
      // here (#82) and the popup has one line per project to say them in — so it
      // says the newest, which is the one an install would leave alone. Which
      // framework is on what belongs to the Projects section, where each has a
      // row of its own.
      const versions = state.packages.installed
        .filter((i) => packageIdsEqual(i.id, selectedPackageId) && pathsEqual(i.projectPath, p.absolutePath))
        .map((i) => i.resolvedVersion)
        .sort((a, b) => compareSemVer(b, a));
      if (versions.length > 0) map[p.absolutePath] = versions[0];
    }
    return map;
  })();

  /**
   * Projects where leaving a framework out would have to rebuild the reference
   * rather than write through it (#82) — read from the versions, the same way
   * the Projects section reads them, and re-checked against the project file by
   * the host before anything is written.
   */
  const splitsReference = (() => {
    if (!scope || (scope.kind !== 'solution' && scope.kind !== 'folder')) return [];
    return scope.projects
      .filter((p) => narrowingSplitsReference(
        state.packages.installed,
        selectedPackageId,
        p.absolutePath,
        state.packages.projectFrameworks[p.absolutePath]
          ?? Object.entries(state.packages.projectFrameworks)
            .find(([key]) => pathsEqual(key, p.absolutePath))?.[1],
      ))
      .map((p) => p.absolutePath);
  })();

  /** Those of them the user actually narrowed, named for the confirmation. */
  const splittingProjects = (frameworks?: Record<string, string[]>) => {
    if (!frameworks || !scope || (scope.kind !== 'solution' && scope.kind !== 'folder')) return [];
    return scope.projects
      .filter((p) => frameworks[p.absolutePath]?.length && splitsReference.includes(p.absolutePath))
      .map((p) => ({ name: p.name, frameworks: frameworks[p.absolutePath] }));
  };

  /**
   * The questions an install from the popup has to ask before it is sent, in
   * the order a project meets them (#82).
   */
  const askThenInstall = (projects: string[], frameworks?: Record<string, string[]>) => {
    // A framework the chosen version would take out of its line asks first.
    // A project narrowed to some of its frameworks is exempt: choosing them is
    // the decision already.
    const crossed = pinsCrossedBy(
      state.packages.installed,
      selectedPackageId,
      projects.filter((p) => !frameworks?.[p]?.length),
      effectiveVersion,
    );
    if (crossed.length > 0) {
      setCrossLine({ projects, frameworks: crossed, frameworksByProject: frameworks });
      return;
    }
    startInstall(projects, frameworks);
  };

  /** A decision the user made in a popup, or the set they applied (#27 follow-up). */
  const logDecision = (action: 'confirm' | 'apply', detail: string[]) => {
    send({
      type: 'WEBVIEW_ACTION',
      action,
      packageId: selectedPackageId ?? undefined,
      version: effectiveVersion || undefined,
      detail,
    });
  };

  const handlePopupConfirm = (projects: string[], frameworks?: Record<string, string[]>) => {
    if (showPopup === 'install' && updatesBlocked) {
      setShowPopup(null);
      return;
    }
    if (showPopup === 'install') {
      // The set as it stood when Apply was pressed. `dotnet add` records the
      // projects that were taken; nothing records the ones that were unticked,
      // and "why was this project not touched" is the question that needs them.
      const narrowed = Object.entries(frameworks ?? {})
        .map(([project, tfms]) => `${fileNameNoExt(project)}: ${tfms.join(', ')}`);
      logDecision('apply', [
        `${projects.length} project(s)`,
        ...(narrowed.length > 0 ? [`narrowed to ${narrowed.join(' · ')}`] : []),
      ]);
      // A narrowing the project file cannot express as it stands asks before
      // anything else: it rebuilds the reference, which is a change the user
      // did not ask for on its own (#82).
      const splitting = splittingProjects(frameworks);
      if (splitting.length > 0 && frameworks) {
        setShowPopup(null);
        setSplitConfirm({ projects, frameworksByProject: frameworks, splitting });
        return;
      }
      setShowPopup(null);
      askThenInstall(projects, frameworks);
      return;
    }
    // The count has to be taken here, before the first project reports back:
    // once rows start clearing, the loading set no longer says how many there
    // were (#104).
    dispatch({
      type: 'START_PROJECT_OPERATION',
      operation: 'remove',
      total: projects.length,
    });
    for (const p of projects) {
      dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
      dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    }
    if (showPopup === 'remove') {
      send({ type: 'REMOVE_PACKAGE_MULTI', projects, packageId: selectedPackageId });
    }
    setShowPopup(null);
  };

  return (
    <div className="detail-panel">
      <DetailHeader
        name={selectedPackageId}
        // In solution scope the Projects section's own title carries the strip,
        // beside the rows the operation is changing (#104).
        progress={isMultiProject ? undefined : <OperationProgressStrip className="detail-header__progress" />}
        // The name row carries nothing: the button that applies a version
        // belongs to the version and is joined to it below, and Remove sits
        // beside the pair — the same shape the project rows have (#82).
        actions={null}
      >
        <div className="version-row">
        <div className="version-apply">
          <VersionSelector
            packageId={selectedPackageId}
            versions={allVersions}
            selected={effectiveVersion}
            onChange={setSelectedVersion}
            restoredVersion={restoredEntry?.resolvedVersion ?? ''}
            restoredProjectPath={restoredEntry?.projectPath ?? ''}
          />
          <button
            className={`btn btn--icon version-apply__btn ${
              isInstalled && updateTone === 'same' ? 'btn--secondary' : 'btn--primary'
            }`}
            onClick={() => {
              if (isInstalled && updatesBlocked) {
                send({
                  type: 'SHOW_TOAST',
                  message: `${selectedPackageId}: ${BLOCKED_UPDATES_TOOLTIP}`,
                });
                return;
              }
              handleInstallUpdate();
            }}
            disabled={isLoading}
            aria-disabled={(isInstalled && updatesBlocked) || undefined}
            title={isInstalled ? updateTitle : 'Install selected version'}
            aria-label={isInstalled ? 'Update' : 'Install'}
          >{isInstalled
            ? (updateTone === 'same' ? <IconCheck /> : updateGlyph)
            : <IconInstall />}</button>
        </div>
        {isInstalled && (
          <button
            className="btn btn--icon pkg-remove-btn"
            onClick={handleRemove}
            disabled={isLoading}
            title="Remove package"
            aria-label="Remove"
          ><IconTrash /></button>
        )}
        </div>
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

            {/* Everything above describes one version, and the solution may be
                holding several. Naming the rest is what keeps the panel from
                quietly speaking for a project it is not describing (#90); which
                project is on what is the Projects section's job, just below. */}
            {spread && spread.others.length > 0 && (
              <div className="pkg-info__elsewhere">
                showing {spread.primary} · also{' '}
                {spread.others
                  .map((o) => (o.frameworks?.length
                    ? `${o.version} in ${o.frameworks.join(', ')}`
                    : `${o.version} in ${o.projectCount} project${o.projectCount === 1 ? '' : 's'}`))
                  .join(', ')}
              </div>
            )}

            {problems.length > 0 && (
              <div className="problems-band">
                <div className="detail-section__title">Problems</div>
                <ul className="vuln-list">
                  {problems.map((p, index) => {
                    const via = p.kind === 'vulnerability' ? p.via : undefined;
                    // The offer belongs to the feed advisory it corrects, not to
                    // whatever else happens to render after it (#114) — a licence
                    // row listed below the advisory must not make the offer read
                    // as if it followed from that. It sits right after the last
                    // feed-advisory row instead of after the whole list.
                    const isLastFeedAdvisory = p.kind === 'feed-advisory'
                      && !problems.slice(index + 1).some((later) => later.kind === 'feed-advisory');
                    return (
                    <React.Fragment key={p.key}>
                    <li className={`vuln-item vuln-item--${p.tone}${via ? ' vuln-item--via' : ''}`}>
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
                        ) : p.kind === 'unlisted' ? (
                          <>
                            <strong>{p.version}</strong> is no longer listed on its feed — it still restores from
                            the cache, but a clean machine may not find it
                          </>
                        ) : p.kind === 'feed-advisory' ? (
                          <>
                            {p.url ? (
                              <a href={p.url} target="_blank" rel="noopener noreferrer">
                                {p.url.split('/').pop()}
                              </a>
                            ) : 'Advisory'}
                            {' · '}the feed flags <strong>{p.version}</strong>
                            {isInstalled ? ', the version selected here' : ''}
                          </>
                        ) : p.kind === 'licence' ? (
                          <>
                            <strong><LicenseSideText side={p.change.from} /></strong>
                            {' → '}
                            <strong><LicenseSideText side={p.change.to} /></strong>
                            {p.change.unnamed
                              ? ' — this version carries its licence as a file, which this extension cannot read. Open it before taking the update.'
                              : ''}
                          </>
                        ) : (
                          <>
                            Updates are blocked for this package in this workspace. Right-click the row and choose{' '}
                            <strong>Unblock updates</strong> to allow a version change.
                          </>
                        )}
                      </span>
                    </li>
                    {/* Every entry is already in memory, so the nearest version
                        the advisory does not cover is free to work out — and
                        turns a warning into something the reader can act on in
                        one click (#114). Kept right after the advisory it
                        corrects, inside the same list, so a licence row printed
                        below it can't make the offer read as if it followed from
                        that instead. */}
                    {isLastFeedAdvisory && nearestClean && (
                      <li className="problems-band__offer">
                        <span aria-hidden="true">↑</span>{' '}
                        <strong>{nearestClean}</strong> is the nearest version this advisory does not cover
                        {' '}
                        <button
                          type="button"
                          className="problems-band__pick"
                          onClick={() => setSelectedVersion(nearestClean)}
                        >pick it</button>
                      </li>
                    )}
                    </React.Fragment>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <PackageAttributeColumn
            license={metadata.license}
            published={publishedOfSelected}
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
          <div className="detail-section__title detail-section__title--strip">
            Projects
            <OperationProgressStrip countProjects />
          </div>
          <ProjectListSection
            packageId={selectedPackageId}
            projects={scope.projects}
            installed={state.packages.installed}
            allVersions={allVersions}
          />
        </div>
      )}

      {/* Describes the picked version, so it sits above the resolved tree, which
          still describes what is installed now (#114). */}
      {versionChanges && isInstalled && installedFrom && (
        <VersionChangesBand diff={versionChanges} from={installedFrom} to={effectiveVersion} />
      )}

      {/* The resolved tree when there is a restore graph to read one from, and
          what the version declares when there is not (#114). Never both: they
          answer the same question, and the declared ranges are the weaker
          answer — kept only until an install produces the real one. */}
      {metadata?.dependencyTree
        ? <PackageDependenciesSection info={metadata.dependencyTree} />
        : metadata?.declaredDependencies && (
          <DeclaredDependenciesSection
            // Resets the picked framework with the package: a choice made about
            // one package's frameworks says nothing about the next one's.
            key={selectedPackageId}
            groups={metadata.declaredDependencies}
            projectFrameworks={workspaceFrameworks}
          />
        )}

      {/* ── Popup ── */}
      {splitConfirm && (
        <SplitReferencePopup
          packageId={selectedPackageId}
          projects={splitConfirm.splitting}
          version={effectiveVersion}
          onConfirm={() => {
            const pending = splitConfirm;
            logDecision('confirm', ['split the shared reference', 'confirmed']);
            setSplitConfirm(null);
            askThenInstall(pending.projects, pending.frameworksByProject);
          }}
          onCancel={() => {
            logDecision('confirm', ['split the shared reference', 'cancelled']);
            setSplitConfirm(null);
          }}
        />
      )}

      {crossLine && (
        <CrossLinePopup
          packageId={selectedPackageId}
          frameworks={crossLine.frameworks}
          toVersion={effectiveVersion}
          onConfirm={() => {
            const pending = crossLine;
            logDecision('confirm', ['cross a pinned major line', 'confirmed']);
            setCrossLine(null);
            startInstall(pending.projects, pending.frameworksByProject, true);
          }}
          onCancel={() => {
            logDecision('confirm', ['cross a pinned major line', 'cancelled']);
            setCrossLine(null);
          }}
        />
      )}

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
          frameworksByProject={showPopup === 'install' ? state.packages.projectFrameworks : undefined}
          splitsReference={showPopup === 'install' ? splitsReference : undefined}
          onConfirm={handlePopupConfirm}
          onCancel={() => setShowPopup(null)}
        />
      )}
    </div>
  );
}
