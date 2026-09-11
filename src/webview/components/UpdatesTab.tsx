import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import {
  collectFamilyGroups,
  collectOtherItems,
  collectUpdatableItems,
  familyItemsAtVersion,
  intersectVersions,
  sortVersionsDesc,
  suggestedFamilyVersion,
  type FamilyGroup,
} from '../../batchUpdates';
import { isCodeAnalysisFamily, versionsAtOrBelow } from '../../roslynSdkCap';
import { compareSemVer } from '../../semver';
import { bestOverlapCandidate, memberKeysOf } from '../familySelection';
import { fileNameNoExt } from '../utils/pathUtils';
import { versionTone } from '../utils/versionTone';
import { SplitPane } from './SplitPane';
import { VersionSelect } from './VersionSelector';
import { PkgListRow } from './PkgListRow';
import { PrereleaseToggle } from './PrereleaseToggle';
import { ToolbarRestoreRefresh } from './ToolbarRestoreRefresh';
import { ActivityStrip } from './ActivityStrip';
import { DetailHeader } from './DetailHeader';
import { BlockedPackageMenu } from './BlockedPackageMenu';
import { PackagesSkeleton } from './InstalledList';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked, withoutBlocked } from '../../blockedPackages';
import type { BatchUpdateItem, BatchUpdateJob, BatchUpdateItemView } from '../../types';
import { searchableConfigFiles } from '../../searchConfigFiles';
import { mergeFamilyVersionFlags } from '../utils/familyVersionFlags';
import { IconCheck } from '../utils/icons';

type Selection =
  | { type: 'all' }
  | { type: 'other' }
  | { type: 'family'; family: string; fromVersion: string; memberKeys: string[] };

function statusLabel(item: BatchUpdateItemView): string {
  switch (item.status) {
    case 'pending': return 'Queued';
    case 'running': return 'Updating…';
    case 'ok': return 'Updated';
    case 'error': return 'Failed';
    case 'timeout': return 'Timed out';
    case 'cancelled': return 'Stopped';
    default: return item.status;
  }
}

// Family-only, deliberately ignoring `fromVersion`/`memberKeys` — this
// tracks "which group is the user looking at" across an update that shifts
// the group's own resolved version (see the "follow" effect below), same as
// jobMatchesSelection already does for matching a running/finished job.
function selectionKey(sel: Selection | null): string {
  if (!sel) return '';
  if (sel.type === 'all') return 'all';
  if (sel.type === 'other') return 'other';
  return `family:${sel.family}`;
}

function jobMatchesSelection(job: BatchUpdateJob, sel: Selection | null): boolean {
  if (!sel) return false;
  if (sel.type === 'all' || sel.type === 'other') return job.kind === sel.type;
  return job.kind === 'family' && (job.family ?? '') === sel.family;
}

function itemCompletedCount(item: BatchUpdateItemView): number {
  if (item.status === 'pending') return 0;
  if (item.status !== 'running') return item.projects.length;
  return item.completedProjects?.length ?? item.succeededProjects.length;
}

function itemFailedCount(item: BatchUpdateItemView): number {
  const succeeded = item.succeededProjects.length;
  if (item.status === 'error' || item.status === 'timeout') {
    return Math.max(0, item.projects.length - succeeded);
  }
  if (item.status === 'running' || item.status === 'cancelled') {
    return Math.max(0, itemCompletedCount(item) - succeeded);
  }
  return 0;
}

function jobProgress(job: BatchUpdateJob) {
  const packageTotal = job.items.length;
  const packageDone = job.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length;
  const projectTotal = job.items.reduce((n, i) => n + i.projects.length, 0);
  const projectDone = job.items.reduce((n, i) => n + itemCompletedCount(i), 0);
  return { packageTotal, packageDone, projectTotal, projectDone };
}

function batchProgressLabel(job: BatchUpdateJob): string {
  const p = jobProgress(job);
  return `${p.packageDone}/${p.packageTotal} pkg · ${p.projectDone}/${p.projectTotal} proj`;
}

function projectNames(projects: string[]): string {
  return projects.map(fileNameNoExt).join(', ');
}

function VersionPair({
  from,
  to,
  highlight,
  failed,
}: {
  from: string;
  to: string;
  highlight?: boolean;
  failed?: boolean;
}) {
  const showTo = !!to && to !== from;
  return (
    <div className="pkg-row__meta pkg-row__meta--pair">
      <span className="pkg-row__version">{from}</span>
      {showTo ? <span className="pkg-row__arrow" aria-hidden="true">→</span> : null}
      {showTo ? (
        <span className={`pkg-row__latest${highlight ? ' pkg-row__latest--update' : ''}${failed ? ' pkg-row__latest--fail' : ''}`}>
          {to}
        </span>
      ) : null}
    </div>
  );
}

function GroupRow({
  name,
  count,
  selected,
  hasUpdate,
  fromLabel,
  toLabel,
  framework,
  onActivate,
}: {
  name: string;
  count: number;
  /** Set when this group exists because its members are pinned to one TFM (#82). */
  framework?: string;
  selected: boolean;
  hasUpdate: boolean;
  fromLabel?: string;
  toLabel?: string;
  onActivate: () => void;
}) {
  return (
    <PkgListRow
      name={name}
      selected={selected}
      hasUpdate={hasUpdate}
      onActivate={onActivate}
      aside={(
        <>
          {framework && (
            <span
              className="pkg-row__tfm"
              title={`These members are referenced only from ${framework}`}
            >{framework}</span>
          )}
          <span className="pkg-row__source">{count}</span>
        </>
      )}
    >
      {fromLabel ? (
        <VersionPair from={fromLabel} to={toLabel ?? ''} highlight={hasUpdate && !!toLabel} />
      ) : null}
    </PkgListRow>
  );
}

export function UpdatesTab() {
  const { state, send } = useNugetManager();
  const { installed, prerelease, enrichProgress, isLoadingPackages, blockedPackages } = state.packages;
  const { jobs, versionsByPackageId = {}, flagsByPackageId = {} } = state.updates;
  const roslynCap = state.roslynCap;
  const configFiles = searchableConfigFiles(state.sources.configChain);
  const batchBusy = jobs.some((j) => !j.finishedAt);
  const [menu, setMenu] = useState<{ packageId: string; blocked: boolean; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const allUpdatable = collectUpdatableItems(installed, roslynCap);
  const updatable = withoutBlocked(allUpdatable, blockedPackages);
  const families = collectFamilyGroups(installed, roslynCap).map((g) => ({
    ...g,
    updateCount: g.members.filter((m) =>
      !isPackageBlocked(m.packageId, blockedPackages)
      && !!m.latestVersion
      && compareSemVer(m.latestVersion, g.fromVersion) > 0,
    ).length,
  }));
  const allOther = collectOtherItems(installed, families, roslynCap);
  const otherItems = withoutBlocked(allOther, blockedPackages);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [familyTarget, setFamilyTarget] = useState('');
  const [resultLockKey, setResultLockKey] = useState('');
  const requestedRef = useRef('');

  const selectedFamily: FamilyGroup | undefined =
    selection?.type === 'family'
      ? families.find((g) => g.family === selection.family && g.fromVersion === selection.fromVersion)
        ?? bestOverlapCandidate(families.filter((g) => g.family === selection.family), selection.memberKeys)
      : undefined;

  // Once the members we're tracking land in a bucket at a new fromVersion
  // (e.g. right after an update), re-anchor the selection on that bucket's
  // own (fromVersion, memberKeys) so highlighting and the exact-match lookup
  // above stay in sync going forward.
  useEffect(() => {
    if (selection?.type !== 'family' || !selectedFamily) return;
    if (selectedFamily.fromVersion === selection.fromVersion) return;
    setSelection({
      type: 'family',
      family: selectedFamily.family,
      fromVersion: selectedFamily.fromVersion,
      memberKeys: memberKeysOf(selectedFamily),
    });
  }, [selection, selectedFamily]);

  const familyIds = selectedFamily?.members.map((m) => m.packageId) ?? [];

  useEffect(() => {
    if (!selectedFamily || configFiles.length === 0) return;
    const key = `${familyIds.join('|')}::${prerelease}`;
    if (requestedRef.current === key) return;
    requestedRef.current = key;
    for (const packageId of familyIds) {
      send({ type: 'GET_ALL_VERSIONS', packageId, configFiles, prerelease });
    }
  }, [selectedFamily, familyIds.join('|'), prerelease, configFiles.join(','), send]);

  // One target version, applied to every member — so a version any member is
  // flagged for is flagged here, and the tooltip names which ones (#92).
  const familyVersionFlags = useMemo(
    () => (selectedFamily
      ? mergeFamilyVersionFlags(selectedFamily.members.map((m) => ({
        packageId: m.packageId,
        flags: flagsByPackageId[m.packageId.toLowerCase()],
      })))
      : {}),
    [selectedFamily, flagsByPackageId],
  );

  const familyVersions = useMemo(() => {
    if (!selectedFamily) return [];
    const lists = selectedFamily.members.map(
      (m) => versionsByPackageId[m.packageId.toLowerCase()] ?? [],
    );
    const loaded = lists.filter((l) => l.length > 0);
    const suggested = suggestedFamilyVersion(selectedFamily.members, selectedFamily.fromVersion);
    const extras = suggested ? [suggested] : [];
    let versions = loaded.length === selectedFamily.members.length
      ? sortVersionsDesc([...intersectVersions(loaded), ...extras])
      : sortVersionsDesc([...loaded.flat(), ...extras]);
    if (isCodeAnalysisFamily(selectedFamily.family)) {
      if (!roslynCap) return [];
      versions = sortVersionsDesc(versionsAtOrBelow(versions, roslynCap.compilerVersion));
    }
    return versions;
  }, [selectedFamily, versionsByPackageId, roslynCap]);

  useEffect(() => {
    if (!selectedFamily) {
      setFamilyTarget('');
      return;
    }
    setFamilyTarget((current) => {
      if (current && familyVersions.includes(current)) return current;
      const suggested = suggestedFamilyVersion(selectedFamily.members, selectedFamily.fromVersion);
      if (suggested && (familyVersions.length === 0 || familyVersions.includes(suggested))) {
        return suggested;
      }
      const newer = familyVersions.find((v) => compareSemVer(v, selectedFamily.fromVersion) > 0);
      return newer ?? familyVersions[0] ?? suggested ?? '';
    });
  }, [selectionKey(selection), familyVersions.join(','), selectedFamily?.fromVersion]);

  const previewItems: BatchUpdateItem[] =
    selection?.type === 'all' ? updatable
      : selection?.type === 'other' ? otherItems
        : selectedFamily
          ? withoutBlocked(familyItemsAtVersion(selectedFamily.members, familyTarget), blockedPackages)
          : [];

  const previewRows = selection?.type === 'family' && selectedFamily
    ? selectedFamily.members.map((m) => {
        const blocked = isPackageBlocked(m.packageId, blockedPackages);
        return {
          packageId: m.packageId,
          fromVersion: m.fromVersion,
          toVersion: familyTarget || m.latestVersion || m.fromVersion,
          skipped: blocked || !familyTarget || familyTarget === m.fromVersion,
          blocked,
          projects: m.projects,
          framework: m.framework,
        };
      })
    : (selection?.type === 'all' ? allUpdatable : allOther).map((i) => {
        const blocked = isPackageBlocked(i.packageId, blockedPackages);
        return {
          packageId: i.packageId,
          fromVersion: i.fromVersion,
          toVersion: i.toVersion,
          skipped: blocked,
          blocked,
          projects: i.projects,
          framework: i.framework,
        };
      });

  const listRows = previewRows;
  const showPackageList = listRows.length > 0;
  const blockedOnly = previewItems.length === 0 && listRows.some((row) => row.blocked);

  const runningJob = jobs.find((j) => !j.finishedAt);
  const selKey = selectionKey(selection);

  useEffect(() => {
    if (runningJob) setResultLockKey(selKey);
  }, [runningJob?.id]);

  useEffect(() => {
    if (resultLockKey && selKey !== resultLockKey) setResultLockKey('');
  }, [selKey]);

  const lockedJob = resultLockKey && selKey === resultLockKey && selection
    ? jobs.find((j) => jobMatchesSelection(j, selection))
    : undefined;
  useEffect(() => {
    if (lockedJob?.stale) setResultLockKey('');
  }, [lockedJob?.stale]);

  const resultJob = runningJob
    ?? (lockedJob && !lockedJob.stale && lockedJob.finishedAt ? lockedJob : undefined);

  const startBatch = () => {
    if (blockedOnly) {
      send({ type: 'SHOW_TOAST', message: BLOCKED_UPDATES_TOOLTIP });
      return;
    }
    if (previewItems.length === 0) return;
    setResultLockKey(selKey);
    if (selection?.type === 'all' || selection?.type === 'other') {
      send({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: selection.type,
        includePrerelease: prerelease,
        items: previewItems,
      });
      return;
    }
    if (selection?.type === 'family' && selectedFamily) {
      send({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'family',
        family: selectedFamily.family,
        includePrerelease: prerelease,
        items: previewItems,
      });
    }
  };

  // All / Other targets are always filtered to latest > resolved, so they're
  // always an upgrade; a family's shared target is picked manually and can
  // land below the current shared version (#55).
  const groupTone = selection?.type === 'family'
    ? versionTone(selectedFamily?.fromVersion, familyTarget)
    : 'up';
  const groupGlyph = groupTone === 'down' ? '↓' : groupTone === 'same' ? '=' : '↑';

  const title = selection?.type === 'all'
    ? 'All'
    : selection?.type === 'other'
      ? 'Other'
      : selectedFamily
        ? `${selectedFamily.family}.*`
        : '';

  return (
    <div className="split-tab">
      <div className="pkg-toolbar">
        <ToolbarRestoreRefresh disabled={batchBusy} />
        <span className="pkg-toolbar__spacer" />
        {runningJob ? (
          <span className="pkg-toolbar__progress" aria-live="polite">
            {batchProgressLabel(runningJob)}
          </span>
        ) : enrichProgress ? (
          <span className="pkg-toolbar__progress" aria-live="polite">
            {enrichProgress.done}/{enrichProgress.total}
          </span>
        ) : null}
        <PrereleaseToggle />
      </div>
      <ActivityStrip />

      <SplitPane
        splitLabel="Resize update groups"
        left={
          <section className="pkg-section" aria-label="Update groups">
            <div className="pkg-section__header">
              Groups
              {!isLoadingPackages && <span>{2 + families.length}</span>}
            </div>
            {isLoadingPackages && <PackagesSkeleton />}
            <div className="pkg-section__list" role="listbox" aria-label="Update groups">
              <GroupRow
                name="All"
                count={updatable.length}
                selected={selection?.type === 'all'}
                hasUpdate={updatable.length > 0}
                onActivate={() => setSelection({ type: 'all' })}
              />
              <div className="update-groups__rule" />
              {families.map((g) => {
                const selected = selection?.type === 'family'
                  && selection.family === g.family
                  && selection.fromVersion === g.fromVersion;
                const suggested = suggestedFamilyVersion(g.members, g.fromVersion);
                return (
                  <GroupRow
                    key={`${g.family}@${g.fromVersion}`}
                    name={`${g.family}.*`}
                    count={g.updateCount}
                    framework={g.framework}
                    selected={selected}
                    hasUpdate={g.updateCount > 0}
                    fromLabel={g.fromVersion}
                    toLabel={suggested ?? ''}
                    onActivate={() => setSelection({
                      type: 'family',
                      family: g.family,
                      fromVersion: g.fromVersion,
                      memberKeys: memberKeysOf(g),
                    })}
                  />
                );
              })}
              {families.length > 0 && <div className="update-groups__rule" />}
              <GroupRow
                name="Other"
                count={otherItems.length}
                selected={selection?.type === 'other'}
                hasUpdate={otherItems.length > 0}
                onActivate={() => setSelection({ type: 'other' })}
              />
            </div>
          </section>
        }
        right={
          !selection && !resultJob ? (
            <div className="detail-panel__empty">Select All, a family, or Other to preview updates</div>
          ) : (
            <div className="detail-panel">
              {selection && (
                <DetailHeader
                  name={title}
                  actions={runningJob && jobMatchesSelection(runningJob, selection) ? (
                    <button
                      type="button"
                      className="btn btn--icon btn--danger"
                      title="Stop group update"
                      aria-label="Stop group update"
                      onClick={() => send({ type: 'CANCEL_BATCH_UPDATE' })}
                    >
                      ■
                    </button>
                  ) : selection.type === 'family' ? null : (
                    // All and Other have no version to choose, so their button
                    // stays here; a family's sits joined to its target below (#82).
                    <button
                      type="button"
                      className={`btn btn--icon ${groupTone === 'same' ? 'btn--secondary' : 'btn--primary'}`}
                      disabled={batchBusy || (previewItems.length === 0 && !blockedOnly)}
                      aria-disabled={blockedOnly || undefined}
                      title={blockedOnly
                        ? BLOCKED_UPDATES_TOOLTIP
                        : `Update ${previewItems.length} package(s) to latest`}
                      aria-label="Update"
                      onClick={startBatch}
                    >
                      {groupGlyph}
                    </button>
                  )}
                >
                  {selection.type === 'family' && (
                    // Joined to the button that applies it, the same pair the
                    // package rows use (#82). All and Other have no version to
                    // pick, so their button stays in the header above.
                    <div className="version-apply">
                      <VersionSelect
                        versions={familyVersions}
                        selected={familyTarget}
                        label="Target version for family"
                        onChange={setFamilyTarget}
                        versionFlags={familyVersionFlags}
                      />
                      <button
                        className={`btn btn--icon version-apply__btn ${
                          groupTone === 'same' ? 'btn--secondary' : 'btn--primary'
                        }`}
                        disabled={batchBusy || (previewItems.length === 0 && !blockedOnly)}
                        aria-disabled={blockedOnly || undefined}
                        title={blockedOnly
                          ? BLOCKED_UPDATES_TOOLTIP
                          : `Update ${previewItems.length} package(s) to ${familyTarget}`}
                        aria-label="Update"
                        onClick={startBatch}
                      >{groupTone === 'same' ? <IconCheck /> : groupGlyph}</button>
                    </div>
                  )}
                </DetailHeader>
              )}

              {resultJob && <BatchJobList job={resultJob} />}

              {selection && !resultJob && (
                !showPackageList ? (
                  <div className="empty-state">
                    {selection.type === 'all' || selection.type === 'other'
                      ? enrichProgress
                        ? 'Waiting for latest versions…'
                        : selection.type === 'other'
                          ? 'No updates outside families for the current Pre-release setting.'
                          : 'All packages are up to date for the current Pre-release setting.'
                      : 'Choose a newer version to update this family.'}
                  </div>
                ) : (
                  <section className="pkg-section" aria-label="Packages to update">
                    <div className="pkg-section__header">
                      Packages
                      <span>
                        {listRows.length} pkg · {listRows.reduce((n, r) => n + r.projects.length, 0)} proj
                      </span>
                    </div>
                    <div className="pkg-section__list">
                      {listRows.map((row) => (
                        <PkgListRow
                          // One id can be here once per target framework (#82),
                          // so the id alone is not a key — two rows sharing one
                          // would have React reuse the wrong element.
                          key={row.framework ? `${row.packageId}::${row.framework}` : row.packageId}
                          name={row.packageId}
                          nameTitle={row.framework
                            ? `${row.packageId} · ${row.framework}`
                            : row.packageId}
                          muted={row.skipped || row.blocked}
                          hasUpdate={!row.skipped && !row.blocked}
                          blocked={row.blocked}
                          onContextMenu={(e) => setMenu({
                            packageId: row.packageId,
                            blocked: row.blocked,
                            x: e.clientX,
                            y: e.clientY,
                          })}
                          aside={(
                            <>
                              {row.framework && (
                                <span
                                  className="pkg-row__tfm"
                                  title={`Only the ${row.framework} reference is being changed`}
                                >{row.framework}</span>
                              )}
                              <span className="pkg-row__source" title={projectNames(row.projects)}>
                                {row.projects.length} proj
                              </span>
                            </>
                          )}
                        >
                          <VersionPair
                            from={row.fromVersion}
                            to={row.blocked || row.skipped ? row.fromVersion : row.toVersion}
                            highlight={!row.skipped && !row.blocked}
                          />
                        </PkgListRow>
                      ))}
                    </div>
                  </section>
                )
              )}
            </div>
          )
        }
      />
      {menu ? (
        <BlockedPackageMenu
          packageId={menu.packageId}
          blocked={menu.blocked}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

function ProjectBar({ item }: { item: BatchUpdateItemView }) {
  const total = item.projects.length;
  if (total === 0) return null;
  const okPct = (100 * item.succeededProjects.length) / total;
  const failPct = (100 * itemFailedCount(item)) / total;
  const done = itemCompletedCount(item);
  return (
    <div
      className="pkg-row__bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} projects`}
    >
      <span className="pkg-row__bar-ok" style={{ width: `${okPct}%` }} />
      <span className="pkg-row__bar-fail" style={{ width: `${failPct}%` }} />
    </div>
  );
}

function rowTone(item: BatchUpdateItemView): string {
  if (item.status === 'ok') return 'pkg-row--ok';
  if (item.status === 'error' || item.status === 'timeout') return 'pkg-row--fail';
  if (item.status === 'running') return 'pkg-row--running';
  if (item.status === 'cancelled' || item.status === 'pending') return 'pkg-row--muted';
  return '';
}

function BatchJobList({ job }: { job: BatchUpdateJob }) {
  const stale = !!job.stale;
  return (
    <section className="pkg-section" aria-label="Batch progress">
      <div className="pkg-section__list">
        {job.items.map((item) => {
          const total = item.projects.length;
          const done = itemCompletedCount(item);
          const failed = item.status === 'error' || item.status === 'timeout';
          const stopped = item.status === 'cancelled';
          return (
            <PkgListRow
              // Same reason as the preview list: a framework-pinned package
              // appears once per TFM, and two rows cannot share a key (#82).
              key={item.framework ? `${item.packageId}::${item.framework}` : item.packageId}
              className={stale ? undefined : rowTone(item)}
              name={item.packageId}
              nameTitle={item.error ?? [
                item.packageId,
                item.framework,
                projectNames(item.projects),
              ].filter(Boolean).join(' · ')}
              muted={stale || stopped}
              aside={(
                <>
                  {item.framework && (
                    <span
                      className="pkg-row__tfm"
                      title={`Only the ${item.framework} reference was changed`}
                    >{item.framework}</span>
                  )}
                  <span
                    className="pkg-row__source"
                    title={`${statusLabel(item)} · ${projectNames(item.projects)}`}
                  >
                    {done}/{total}
                  </span>
                </>
              )}
            >
              <VersionPair
                from={item.fromVersion}
                to={item.toVersion}
                highlight={!stale && item.status === 'ok'}
                failed={!stale && failed}
              />
              {!stale && <ProjectBar item={item} />}
            </PkgListRow>
          );
        })}
      </div>
    </section>
  );
}
