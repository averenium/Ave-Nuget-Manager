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
import { IconInstall, IconTrash } from '../utils/icons';

interface Props {
  packageId: string;
  projects: ProjectInfo[];
  installed: InstalledPackage[];
  allVersions: string[];
}

export function ProjectListSection({ packageId, projects, installed, allVersions }: Props) {
  const { state, dispatch, send } = useNugetManager();
  const updatesBlocked = isPackageBlocked(packageId, state.packages.blockedPackages);

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

  if (projectsWithPkg.length === 0 && transitiveRows.length === 0) {
    return <div className="empty-state">Not installed in any project</div>;
  }

  return (
    <div className="project-list" aria-label="Projects with this package">
      {projectsWithPkg.map((proj) => (
        <ProjectRow
          key={proj.absolutePath}
          packageId={packageId}
          project={proj}
          installed={installed}
          allVersions={allVersions}
          updatesBlocked={updatesBlocked}
          state={state}
          dispatch={dispatch}
          send={send}
        />
      ))}
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
  project: ProjectInfo;
  installed: InstalledPackage[];
  allVersions: string[];
  updatesBlocked: boolean;
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

function ProjectRow({ packageId, project, installed, allVersions, updatesBlocked, state, dispatch, send }: RowProps) {
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
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'REMOVE_PACKAGE', projectPath: p, packageId });
  };

  return (
    <div className={`project-row${flashTone ? ` project-row--flash-${flashTone}` : ''}`}>
      <span className="project-row__name" title={p}>{project.name}</span>

      {/* Same feed flags as the panel-level selector: these rows pick a version
          to install just as directly, so a vulnerable or deprecated one has to
          be marked here too (#86). `state.detail.versionFlags` belongs to the
          selected package, which is the package these rows are about. */}
      <VersionSelect
        versions={allVersions}
        selected={localVersion}
        disabled={isLoading}
        label={`Version for ${project.name}`}
        onChange={setLocalVersion}
        versionFlags={state.detail.versionFlags}
      />

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          className={`btn btn--icon ${updateTone === 'same' ? 'btn--secondary' : 'btn--primary'}`}
          onClick={requestApply}
          disabled={isLoading}
          aria-disabled={updatesBlocked || undefined}
          title={updatesBlocked ? BLOCKED_UPDATES_TOOLTIP : `Update ${project.name} to ${localVersion}`}
          aria-label={`Apply version for ${project.name}`}
        >{isLoading ? '…' : updateGlyph}</button>
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
