import React, { useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { InstalledPackage, ProjectInfo } from '../../types';

interface Props {
  packageId: string;
  projects: ProjectInfo[];
  installed: InstalledPackage[];
  allVersions: string[];
}

export function ProjectListSection({ packageId, projects, installed, allVersions }: Props) {
  const { state, dispatch, send } = useNugetManager();

  // Only list projects that have this package installed
  const projectsWithPkg = projects.filter((p) =>
    installed.some((i) => i.id === packageId && i.projectPath === p.absolutePath),
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
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

function ProjectRow({ packageId, project, installed, allVersions, state, dispatch, send }: RowProps) {
  const p = project.absolutePath;
  const currentPkg = installed.find((i) => i.id === packageId && i.projectPath === p);
  const currentVersion = state.detail.projectVersions[p] ?? currentPkg?.resolvedVersion ?? allVersions[0] ?? '';
  const isLoading = state.detail.projectLoadingSet.has(p);
  const error = state.detail.projectErrors[p];

  const [localVersion, setLocalVersion] = useState(currentVersion);

  const handleApply = async () => {
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

      <select
        value={localVersion}
        onChange={(e) => setLocalVersion(e.target.value)}
        disabled={isLoading}
        aria-label={`Version for ${project.name}`}
      >
        {allVersions.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          className="btn btn--icon btn--primary"
          onClick={handleApply}
          disabled={isLoading}
          title={`Update ${project.name} to ${localVersion}`}
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
