import React, { useEffect, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { InstalledPackage, ProjectInfo } from '../../types';
import { packageIdsEqual, pathsEqual } from '../../pathCompare';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked } from '../../blockedPackages';
import { VersionSelect } from './VersionSelector';

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

  if (projectsWithPkg.length === 0) {
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

  useEffect(() => {
    if (installedVersion) setLocalVersion(installedVersion);
  }, [installedVersion]);

  const handleApply = async () => {
    if (updatesBlocked) return;
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'INSTALL_PACKAGE', projectPath: p, packageId, version: localVersion });
  };

  const handleRemove = () => {
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'REMOVE_PACKAGE', projectPath: p, packageId });
  };

  return (
    <div className="project-row">
      <span className="project-row__name" title={p}>{project.name}</span>

      <VersionSelect
        versions={allVersions}
        selected={localVersion}
        disabled={isLoading}
        label={`Version for ${project.name}`}
        onChange={setLocalVersion}
      />

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          className="btn btn--icon btn--primary"
          onClick={() => {
            if (updatesBlocked) {
              send({ type: 'SHOW_TOAST', message: `${packageId}: ${BLOCKED_UPDATES_TOOLTIP}` });
              return;
            }
            void handleApply();
          }}
          disabled={isLoading}
          aria-disabled={updatesBlocked || undefined}
          title={updatesBlocked ? BLOCKED_UPDATES_TOOLTIP : `Update ${project.name} to ${localVersion}`}
          aria-label={`Apply version for ${project.name}`}
        >{isLoading ? '…' : '↑'}</button>
        <button
          className="btn btn--icon btn--danger"
          onClick={handleRemove}
          disabled={isLoading}
          title={`Remove from ${project.name}`}
          aria-label={`Remove from ${project.name}`}
        >✕</button>
      </div>

      {error && <div className="project-row__error" role="alert">{error}</div>}
    </div>
  );
}
