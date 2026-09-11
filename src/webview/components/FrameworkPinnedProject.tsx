import React, { useEffect, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { ProjectInfo } from '../../types';
import { tfmBadgeWidth, type FrameworkRow as Row } from '../../frameworkPins';
import { pathsEqual } from '../../pathCompare';
import { BLOCKED_UPDATES_TOOLTIP } from '../../blockedPackages';
import { compareSemVer } from '../../semver';
import { needsRoslynUpgradeConfirm } from '../../roslynSdkCap';
import { RoslynCapPopup } from './RoslynCapPopup';
import { CrossLinePopup } from './CrossLinePopup';
import { sameMajorLine } from '../../frameworkPins';
import { VersionSelect } from './VersionSelector';
import { versionTone } from '../utils/versionTone';
import { IconCheck, IconChevronDown, IconInstall, IconTrash } from '../utils/icons';

interface Props {
  packageId: string;
  project: ProjectInfo;
  rows: Row[];
  allVersions: string[];
  updatesBlocked: boolean;
  /**
   * One unconditional reference still covers every framework here (#82). A
   * version aimed at one of them cannot be written through that shared line —
   * `dotnet add --framework` would edit it and move all of them — so the row
   * asks for a split instead.
   */
  sharedReference?: boolean;
  /** Closes the per-framework view again; absent when the frameworks disagree and it cannot close. */
  onCollapse?: () => void;
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

/**
 * A project that pins this package per target framework (#82): the name and the
 * remove button on their own line, then one row per framework underneath.
 *
 * The two levels on screen are the two the tooling actually offers. `dotnet
 * remove package` has no `--framework` and takes every conditional reference
 * with it — measured, not assumed — so removal belongs to the project. `dotnet
 * add package --framework` writes one conditional group and leaves the others
 * alone, so the version belongs to the framework.
 */
export function FrameworkPinnedProject({
  packageId, project, rows, allVersions, updatesBlocked, sharedReference, onCollapse,
  state, dispatch, send,
}: Props) {
  const p = project.absolutePath;
  const isLoading = [...state.detail.projectLoadingSet].some((k) => pathsEqual(k, p));
  const errorKey = Object.keys(state.detail.projectErrors).find((k) => pathsEqual(k, p));
  const error = errorKey ? state.detail.projectErrors[errorKey] : undefined;

  const handleRemove = () => {
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'remove', total: 1 });
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    send({ type: 'REMOVE_PACKAGE', projectPath: p, packageId });
  };

  const referenced = rows.filter((row) => row.resolvedVersion).map((row) => row.framework);

  return (
    <div className="project-group">
      <div className="project-row project-row--group-head">
        {onCollapse ? (
          <button
            type="button"
            className="project-row__toggle"
            onClick={onCollapse}
            aria-expanded
            title={`Close ${project.name} back into one row`}
          >
            <span className="project-row__disclosure" aria-hidden="true"><IconChevronDown /></span>
            <span className="project-row__name">{project.name}</span>
          </button>
        ) : (
          <>
            <span className="project-row__disclosure-gap" aria-hidden="true" />
            <span className="project-row__name" title={p}>{project.name}</span>
          </>
        )}
        {/* The gap holds the slot the framework rows spend on their apply
            button, so Remove lands in the same column as every other row's. */}
        <div className="project-row__actions">
          <span className="project-row__action-gap" aria-hidden="true" />
          <button
            className="btn btn--icon pkg-remove-btn"
            onClick={handleRemove}
            disabled={isLoading}
            title={`Remove ${packageId} from ${project.name} — every target framework (${referenced.join(', ')})`}
            aria-label={`Remove from ${project.name}`}
          ><IconTrash /></button>
        </div>
      </div>

      {rows.map((row) => (
        <FrameworkRow
          key={row.framework}
          packageId={packageId}
          project={project}
          row={row}
          sharedWith={sharedReference ? referenced : undefined}
          allVersions={allVersions}
          updatesBlocked={updatesBlocked}
          isLoading={isLoading}
          state={state}
          dispatch={dispatch}
          send={send}
        />
      ))}

      {error && <div className="project-row__error" role="alert">{error}</div>}
    </div>
  );
}

interface RowProps {
  packageId: string;
  project: ProjectInfo;
  row: Row;
  /** Every framework the one shared reference covers, when it is still shared (#82). */
  sharedWith?: string[];
  allVersions: string[];
  updatesBlocked: boolean;
  isLoading: boolean;
  state: ReturnType<typeof useNugetManager>['state'];
  dispatch: ReturnType<typeof useNugetManager>['dispatch'];
  send: ReturnType<typeof useNugetManager>['send'];
}

/**
 * One target framework's pin. The install it sends names the framework, which
 * is what confines `dotnet add` to that conditional group — without it the CLI
 * rewrites every group for the id to this version, and the other framework's
 * pin silently follows along.
 *
 * The picker still offers every version, with the ones outside this
 * framework's line set apart: crossing a major deliberately is a legitimate
 * thing to do, and doing it without noticing is the thing this issue is about.
 */
function FrameworkRow({
  packageId, project, row, sharedWith, allVersions, updatesBlocked, isLoading, state, dispatch, send,
}: RowProps) {
  const p = project.absolutePath;
  const referenced = row.resolvedVersion !== undefined;
  const startingVersion = row.resolvedVersion ?? allVersions[0] ?? '';
  const [localVersion, setLocalVersion] = useState(startingVersion);
  const [showRoslynWarning, setShowRoslynWarning] = useState(false);
  const [showCrossLine, setShowCrossLine] = useState(false);

  useEffect(() => {
    setLocalVersion(startingVersion);
  }, [startingVersion]);

  const updateTone = referenced ? versionTone(row.resolvedVersion, localVersion) : undefined;
  const updateGlyph = updateTone === 'down' ? '↓' : updateTone === 'same' ? '=' : '↑';

  const handleApply = () => {
    if (updatesBlocked) return;
    if (!localVersion) return;
    if (referenced && compareSemVer(localVersion, row.resolvedVersion as string) === 0) return;
    dispatch({ type: 'START_PROJECT_OPERATION', operation: 'install', total: 1 });
    dispatch({ type: 'SET_PROJECT_LOADING', projectPath: p, loading: true });
    dispatch({ type: 'SET_PROJECT_ERROR', projectPath: p, error: null });
    if (sharedWith?.length) {
      // Still one reference for every framework: writing "through" it with
      // `--framework` would move all of them, so the shape is rebuilt instead —
      // this framework at the new version, the rest where they already are.
      send({
        type: 'SPLIT_PACKAGE_REFERENCE',
        projectPath: p,
        packageId,
        frameworks: sharedWith,
        framework: row.framework,
        version: localVersion,
      });
      return;
    }
    send({
      type: 'INSTALL_PACKAGE',
      projectPath: p,
      packageId,
      version: localVersion,
      framework: row.framework,
    });
  };

  const requestApply = () => {
    if (updatesBlocked) {
      send({ type: 'SHOW_TOAST', message: `${packageId}: ${BLOCKED_UPDATES_TOOLTIP}` });
      return;
    }
    // Leaving the line this framework is pinned to is allowed, but not silently
    // (#82): batch updates stay inside it, so a change that crosses is always a
    // deliberate, single-package one and worth one question.
    if (referenced && localVersion && !sameMajorLine(row.resolvedVersion as string, localVersion)) {
      setShowCrossLine(true);
      return;
    }
    if (needsRoslynUpgradeConfirm({
      packageId,
      chosenVersion: localVersion,
      installedVersions: referenced ? [row.resolvedVersion as string] : [],
      cap: state.roslynCap,
    })) {
      setShowRoslynWarning(true);
      return;
    }
    handleApply();
  };

  const where = `${project.name} (${row.framework})`;

  return (
    <div className={`project-row project-row--framework${referenced ? '' : ' project-row--unreferenced'}`}>
      {/* Stepped width, so `net6.0` through `net10.0` line up with each other
          without every badge being sized for a `netstandard2.0` beside them (#82). */}
      <span
        className="project-row__tfm"
        style={{ minWidth: tfmBadgeWidth(row.framework) }}
        title={`Target framework ${row.framework}`}
      >{row.framework}</span>

      <div className="version-apply">
        <VersionSelect
          versions={allVersions}
          selected={localVersion}
          disabled={isLoading}
          label={`Version for ${where}`}
          onChange={setLocalVersion}
          versionFlags={state.detail.versionFlags}
          versionLine={row.resolvedVersion}
        />
        <button
          className={`btn btn--icon version-apply__btn ${updateTone === 'same' ? 'btn--secondary' : 'btn--primary'}`}
          onClick={requestApply}
          disabled={isLoading || !localVersion}
          aria-disabled={updatesBlocked || undefined}
          title={updatesBlocked
            ? BLOCKED_UPDATES_TOOLTIP
            : !referenced
              ? `Reference ${packageId} ${localVersion} from ${row.framework} only`
              : updateTone === 'same'
                ? `${where} is already on ${localVersion}`
                : `Update ${where} to ${localVersion}`}
          aria-label={referenced ? `Apply version for ${where}` : `Add to ${where}`}
        >{isLoading
          ? '…'
          : !referenced
            ? <IconInstall />
            : (updateTone === 'same' ? <IconCheck /> : updateGlyph)}</button>
      </div>

      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <span className="project-row__action-gap" aria-hidden="true" />
      </div>

      {showCrossLine && (
        <CrossLinePopup
          packageId={packageId}
          frameworks={[{ framework: row.framework, version: row.resolvedVersion as string }]}
          toVersion={localVersion}
          onConfirm={() => {
            setShowCrossLine(false);
            handleApply();
          }}
          onCancel={() => setShowCrossLine(false)}
        />
      )}

      {showRoslynWarning && state.roslynCap && (
        <RoslynCapPopup
          packageId={packageId}
          fromVersion={row.resolvedVersion ?? ''}
          toVersion={localVersion}
          cap={state.roslynCap}
          onConfirm={() => {
            setShowRoslynWarning(false);
            handleApply();
          }}
          onCancel={() => setShowRoslynWarning(false)}
        />
      )}
    </div>
  );
}
