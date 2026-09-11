import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { ImplicitPackage, InstalledPackage, ProjectInfo } from '../../types';
import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked } from '../../blockedPackages';
import { VersionSelect } from './VersionSelector';
import { compareSemVer } from '../../semver';
import { needsRoslynUpgradeConfirm } from '../../roslynSdkCap';
import { RoslynCapPopup } from './RoslynCapPopup';
import { versionTone } from '../utils/versionTone';
import { IconCheck, IconChevronRight, IconInstall, IconTrash } from '../utils/icons';
import { frameworkRowsFor, needsFrameworkRows } from '../../frameworkPins';
import { FrameworkPinnedProject } from './FrameworkPinnedProject';

interface Props {
  packageId: string;
  projects: ProjectInfo[];
  installed: InstalledPackage[];
  allVersions: string[];
}

export function ProjectListSection({ packageId, projects, installed, allVersions }: Props) {
  const { state, dispatch, send } = useNugetManager();
  const updatesBlocked = isPackageBlocked(packageId, state.packages.blockedPackages);
  /**
   * Projects opened into their per-framework rows by hand (#82). A project
   * whose frameworks already disagree is opened anyway — there is no single row
   * that could tell the truth about it — so this only holds the ones where the
   * reference is shared and the reader asked to see it apart.
   */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggleOpen = (projectPath: string) => setOpened((current) => {
    const next = new Set(current);
    if (next.has(projectPath)) next.delete(projectPath);
    else next.add(projectPath);
    return next;
  });

  // Only list projects that have this package installed
  const projectsWithPkg = projects.filter((p) =>
    installed.some((i) => packageIdsEqual(i.id, packageId) && pathsEqual(i.projectPath, p.absolutePath)),
  );

  // The rest of the answer to "which of my projects has this?" (#90) — but only
  // for a package nothing references directly. Once some project owns it, this
  // section is about where it is declared, and every project that merely
  // inherits it is noise: `Microsoft.EntityFrameworkCore` is transitive in
  // every project that references any EF package, and offering to pin it there
  // buries the one row that can actually be changed. A package installed
  // nowhere is the opposite case — the transitive rows are the only answer
  // there is, and pinning one is how it becomes managed at all.
  const transitiveRows = (projectsWithPkg.length > 0 ? [] : projects)
    .map((project) => ({
      project,
      entry: state.packages.implicit.find(
        (i) => packageIdsEqual(i.id, packageId) && pathsEqual(i.projectPath, project.absolutePath),
      ),
    }))
    .filter((row): row is { project: ProjectInfo; entry: ImplicitPackage } => row.entry !== undefined);

  const noRows = projectsWithPkg.length === 0 && transitiveRows.length === 0;

  /**
   * A project shows its per-framework rows for one of two reasons (#82): its
   * frameworks disagree — about the version, or about whether the package is
   * referenced at all — and then no single row could tell the truth about it;
   * or the reader opened it, to give one framework a version of its own.
   * Everything else keeps the single row it has always had, which is every
   * single-target project and nearly every multi-target one.
   *
   * The rows come from the project's own frameworks rather than the package's,
   * so a framework the package is missing from is on screen too. Without that,
   * a project targeting `net8.0;net9.0;net10.0` with the package pinned in two
   * of them had no way to reference it from the third.
   */
  const rows = projectsWithPkg.map((proj) => {
    const frameworkRows = frameworkRowsFor(
      installed,
      packageId,
      proj.absolutePath,
      state.packages.projectFrameworks[proj.absolutePath]
        ?? Object.entries(state.packages.projectFrameworks)
          .find(([key]) => pathsEqual(key, proj.absolutePath))?.[1],
    );
    return { proj, frameworkRows, mustSplit: needsFrameworkRows(frameworkRows) };
  });

  return (
    <div className="project-list" aria-label="Projects with this package">
      {noRows && <div className="empty-state">Not installed in any project</div>}
      {rows.map(({ proj, frameworkRows, mustSplit }) => (
        frameworkRows.length > 1 && (mustSplit || opened.has(proj.absolutePath)) ? (
          <FrameworkPinnedProject
            key={proj.absolutePath}
            packageId={packageId}
            project={proj}
            rows={frameworkRows}
            allVersions={allVersions}
            updatesBlocked={updatesBlocked}
            // One reference still covers every framework here, so a version
            // change aimed at one of them has to split it rather than write
            // through the shared line (#82).
            sharedReference={!mustSplit}
            onCollapse={mustSplit ? undefined : () => toggleOpen(proj.absolutePath)}
            state={state}
            dispatch={dispatch}
            send={send}
          />
        ) : (
          <ProjectRow
            key={proj.absolutePath}
            packageId={packageId}
            project={proj}
            installed={installed}
            allVersions={allVersions}
            updatesBlocked={updatesBlocked}
            frameworks={frameworkRows.map((row) => row.framework)}
            onExpand={frameworkRows.length > 1 ? () => toggleOpen(proj.absolutePath) : undefined}
            state={state}
            dispatch={dispatch}
            send={send}
          />
        )))}
      {transitiveRows.map(({ project, entry }) => (
        <TransitiveProjectRow
          key={project.absolutePath}
          packageId={packageId}
          project={project}
          resolvedVersion={entry.resolvedVersion}
          state={state}
          dispatch={dispatch}
          send={send}
        />
      ))}
    </div>
  );
}

interface TransitiveRowProps {
  packageId: string;
  project: ProjectInfo;
  resolvedVersion: string;
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

/**
 * A project that only reaches the package through restore. It has no
 * `PackageReference` to change, so this is a different row rather than the
 * installed one with its controls disabled: the version is a fact, not a
 * choice, and the single action makes the reference explicit at the version
 * already being restored (#90).
 *
 * Pinning cannot change what restore resolves, so it needs neither the
 * Roslyn-cap confirmation nor the blocked-updates gate — both exist to guard a
 * version change, and this is not one.
 */
function TransitiveProjectRow({
  packageId, project, resolvedVersion, state, dispatch, send,
}: TransitiveRowProps) {
  const p = project.absolutePath;
  const isLoading = [...state.detail.projectLoadingSet].some((k) => pathsEqual(k, p));
  const errorKey = Object.keys(state.detail.projectErrors).find((k) => pathsEqual(k, p));
  const error = errorKey ? state.detail.projectErrors[errorKey] : undefined;

  const handlePin = () => {
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'install', total: 1 });
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'INSTALL_PACKAGE', projectPath: p, packageId, version: resolvedVersion });
  };

  return (
    <div className="project-row">
      <span className="project-row__name" title={p}>{project.name}</span>
      <span className="project-row__transitive">transitive</span>
      <span className="project-row__resolved">{resolvedVersion}</span>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          className="btn btn--icon btn--primary"
          onClick={handlePin}
          disabled={isLoading}
          title={`Reference ${packageId} ${resolvedVersion} directly in ${project.name}`}
          aria-label={`Add a direct reference in ${project.name}`}
        >{isLoading ? '…' : <IconInstall />}</button>
        {/* Holds the slot the installed rows spend on Remove, so the version
            column lands at the same x whichever kind of row it belongs to. */}
        <span className="project-row__action-gap" aria-hidden="true" />
      </div>

      {error && <div className="project-row__error" role="alert">{error}</div>}
    </div>
  );
}

interface RowProps {
  packageId: string;
  /** Frameworks this project reports the package under (#82). */
  frameworks?: string[];
  /** Opens the per-framework view; absent when there is only one framework to show. */
  onExpand?: () => void;
  project: ProjectInfo;
  installed: InstalledPackage[];
  allVersions: string[];
  updatesBlocked: boolean;
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

function ProjectRow({
  packageId, project, installed, allVersions, updatesBlocked, frameworks, onExpand,
  state, dispatch, send,
}: RowProps) {
  const p = project.absolutePath;
  const currentPkg = installed.find(
    (i) => packageIdsEqual(i.id, packageId) && pathsEqual(i.projectPath, p),
  );
  const installedVersion = Object.entries(state.detail.projectVersions)
    .find(([k]) => pathsEqual(k, p))?.[1]
    ?? currentPkg?.resolvedVersion
    ?? '';
  const currentVersion = installedVersion || allVersions[0] || '';
  const isLoading = [...state.detail.projectLoadingSet].some((k) => pathsEqual(k, p));
  const errorKey = Object.keys(state.detail.projectErrors).find((k) => pathsEqual(k, p));
  const error = errorKey ? state.detail.projectErrors[errorKey] : undefined;

  const [localVersion, setLocalVersion] = useState(currentVersion);
  const [showRoslynWarning, setShowRoslynWarning] = useState(false);

  useEffect(() => {
    if (installedVersion) setLocalVersion(installedVersion);
  }, [installedVersion]);

  // Brief flash on the row when a version change actually lands, colored by
  // direction — no other feedback exists here otherwise (#56). Depends on
  // the same versionTone comparison #55 uses for the button glyph below.
  const prevInstalledVersionRef = useRef(installedVersion);
  const [flashTone, setFlashTone] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevInstalledVersionRef.current;
    prevInstalledVersionRef.current = installedVersion;
    if (!prev || !installedVersion || prev === installedVersion) return;
    const tone = versionTone(prev, installedVersion);
    if (tone !== 'up' && tone !== 'down') return;
    setFlashTone(tone);
    const timer = setTimeout(() => setFlashTone(null), 850);
    return () => clearTimeout(timer);
  }, [installedVersion]);

  const updateTone = installedVersion ? versionTone(installedVersion, localVersion) : undefined;
  const updateGlyph = updateTone === 'down' ? '↓' : updateTone === 'same' ? '=' : '↑';

  const handleApply = async () => {
    if (updatesBlocked) return;
    if (installedVersion && compareSemVer(localVersion, installedVersion) === 0) return;
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'install', total: 1 });
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'INSTALL_PACKAGE', projectPath: p, packageId, version: localVersion });
  };

  const requestApply = () => {
    if (updatesBlocked) {
      send({ type: 'SHOW_TOAST', message: `${packageId}: ${BLOCKED_UPDATES_TOOLTIP}` });
      return;
    }
    if (needsRoslynUpgradeConfirm({
      packageId,
      chosenVersion: localVersion,
      installedVersions: installedVersion ? [installedVersion] : [],
      cap: state.roslynCap,
    })) {
      setShowRoslynWarning(true);
      return;
    }
    void handleApply();
  };

  const handleRemove = () => {
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'remove', total: 1 });
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'REMOVE_PACKAGE', projectPath: p, packageId });
  };

  return (
    <div className={`project-row${flashTone ? ` project-row--flash-${flashTone}` : ''}`}>
      {onExpand ? (
        // The project targets several frameworks and holds one reference for
        // all of them. Opening it shows the per-framework rows this panel
        // already uses where the versions differ — the same view, on request,
        // instead of a control of its own to learn (#82).
        //
        // The name is part of the control rather than a label beside it: a
        // 16px triangle is a small thing to hit, and one button keeps this a
        // single tab stop with one expanded state to announce.
        <button
          type="button"
          className="project-row__toggle"
          onClick={onExpand}
          aria-expanded={false}
          title={`${project.name} targets ${(frameworks ?? []).join(', ')} — open to give one of them its own version`}
        >
          <span className="project-row__disclosure" aria-hidden="true"><IconChevronRight /></span>
          <span className="project-row__name">{project.name}</span>
        </button>
      ) : (
        <>
          <span className="project-row__disclosure-gap" aria-hidden="true" />
          <span className="project-row__name" title={p}>{project.name}</span>
        </>
      )}

      {/* The version and the button that applies it are one control: the action
          is about the version beside it, and saying so with a shared border is
          shorter than two boxes and a gap in a sidebar this narrow (#82).

          Same feed flags as the panel-level selector: these rows pick a version
          to install just as directly, so a vulnerable or deprecated one has to
          be marked here too (#86). `state.detail.versionFlags` belongs to the
          selected package, which is the package these rows are about. */}
      <div className="version-apply">
        <VersionSelect
          versions={allVersions}
          selected={localVersion}
          disabled={isLoading}
          label={`Version for ${project.name}`}
          onChange={setLocalVersion}
          versionFlags={state.detail.versionFlags}
        />
        <button
          className={`btn btn--icon version-apply__btn ${updateTone === 'same' ? 'btn--secondary' : 'btn--primary'}`}
          onClick={requestApply}
          disabled={isLoading}
          aria-disabled={updatesBlocked || undefined}
          title={updatesBlocked
            ? BLOCKED_UPDATES_TOOLTIP
            : updateTone === 'same'
              ? `${project.name} is already on ${localVersion}`
              : `Update ${project.name} to ${localVersion}`}
          aria-label={`Apply version for ${project.name}`}
        >{isLoading ? '…' : (updateTone === 'same' ? <IconCheck /> : updateGlyph)}</button>
      </div>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          className="btn btn--icon pkg-remove-btn"
          onClick={handleRemove}
          disabled={isLoading}
          title={`Remove from ${project.name}`}
          aria-label={`Remove from ${project.name}`}
        ><IconTrash /></button>
      </div>

      {error && <div className="project-row__error" role="alert">{error}</div>}

      {showRoslynWarning && state.roslynCap && (
        <RoslynCapPopup
          packageId={packageId}
          fromVersion={installedVersion}
          toVersion={localVersion}
          cap={state.roslynCap}
          onConfirm={() => {
            setShowRoslynWarning(false);
            void handleApply();
          }}
          onCancel={() => setShowRoslynWarning(false)}
        />
      )}
    </div>
  );
}
