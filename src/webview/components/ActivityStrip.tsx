import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { BatchUpdateJob } from '../../types';

function runningBatchJob(jobs: BatchUpdateJob[]): BatchUpdateJob | undefined {
  return jobs.find((j) => !j.finishedAt);
}

function batchFillPct(job: BatchUpdateJob): number {
  const projectTotal = job.items.reduce((n, i) => n + i.projects.length, 0);
  if (projectTotal === 0) return 0;
  const projectDone = job.items.reduce((n, i) => {
    if (i.status === 'pending') return n;
    if (i.status === 'running') {
      return n + (i.completedProjects?.length ?? i.succeededProjects.length);
    }
    return n + i.projects.length;
  }, 0);
  return Math.round((100 * projectDone) / projectTotal);
}

/** Fixed-height sliver under the toolbar — never changes layout. */
export function ActivityStrip() {
  const { state } = useNugetManager();
  const activity = state.workspaceActivity;
  const enrich = state.packages.enrichProgress;
  const batchJob = runningBatchJob(state.updates.jobs);
  const enriching = !batchJob && activity?.phase === 'enrich' && enrich;
  const batchPct = batchJob ? batchFillPct(batchJob) : null;

  let label = 'Idle';
  let pct: number | null = null;
  let busy = false;
  if (batchJob) {
    busy = true;
    pct = batchPct && batchPct > 0 ? batchPct : null;
    label = 'Updating packages…';
  } else if (activity) {
    busy = true;
    if (enriching && enrich.total > 0) {
      pct = Math.round((100 * enrich.done) / enrich.total);
      label = `Refreshing latest ${enrich.done}/${enrich.total}`;
    } else {
      label = activity.kind === 'restore' ? 'Restoring…' : 'Refreshing…';
    }
  }

  const classes = [
    'activity-strip',
    busy ? 'activity-strip--busy' : '',
    pct !== null ? 'activity-strip--determinate' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-live="polite" aria-label={label}>
      <div className="activity-strip__track">
        {pct !== null ? (
          <span className="activity-strip__fill" style={{ width: `${pct}%` }} />
        ) : null}
      </div>
    </div>
  );
}
