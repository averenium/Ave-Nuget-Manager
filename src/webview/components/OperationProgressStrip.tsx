import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

interface Props {
  /**
   * Count the projects off as they land, instead of a plain busy shimmer. Only
   * meaningful where the rows being counted are on screen — the Projects
   * section; a single-project scope has nothing to count.
   */
  countProjects?: boolean;
  /** Placement class — where this strip is being hung. */
  className?: string;
}

/**
 * The install/remove indicator (#104): a text-free sliver that rides in space
 * the layout already has — beside a section title, or on the detail header's
 * bottom border — so it costs no room of its own and nothing moves when an
 * operation starts or ends. It carries no label because the fill says how far
 * along the operation is and the row buttons already say which projects are
 * still working.
 *
 * Two phases: the fill counts the projects off while the CLI runs, then a
 * shimmer covers the wait for the refreshed list, where there is nothing left
 * to count.
 */
export function OperationProgressStrip({ countProjects = false, className }: Props) {
  const { state } = useNugetManager();
  const operation = state.detail.projectOperation;
  const counting = countProjects && operation !== null && operation.phase === 'work';
  const verb = operation?.operation === 'install' ? 'Install' : 'Remov';

  let label: string | undefined;
  if (!operation) label = undefined;
  else if (operation.phase === 'refresh') label = 'Refreshing the package list';
  else if (counting) label = `${verb}ing ${operation.done} of ${operation.total} projects`;
  else label = `${verb}ing`;

  return (
    <span
      className={[
        'operation-strip',
        operation ? 'operation-strip--busy' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className={`activity-strip__track${counting ? '' : ' activity-strip__track--indeterminate'}`}>
        {counting && (
          <span
            className="activity-strip__fill"
            style={{ width: `${Math.round((100 * operation.done) / Math.max(operation.total, 1))}%` }}
          />
        )}
      </span>
    </span>
  );
}
