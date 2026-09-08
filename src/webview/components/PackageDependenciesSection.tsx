import React from 'react';
import type { DependencyRow, PackageDependencyInfo } from '../../types';
import { IconMarkWarning } from '../utils/icons';

/**
 * Direct + transitive dependencies of the package shown in the Info panel,
 * resolved from `project.assets.json` (declared range vs. resolved version)
 * — see `packageDependencyTree.ts` / `packageVersionRanges.ts` (#86 design
 * pass, "Dependencies"). Two annotations, deliberately different weights:
 * a range with a ceiling that the resolved version violates is red on the
 * version itself (NuGet already reports this as NU1608, on a build that
 * still succeeds); a bare-minimum floor whose major was lifted is a quiet
 * amber annotation next to the version, never on the version itself — a
 * recommendation to glance, not a claim of breakage.
 */
export function PackageDependenciesSection({ info }: { info: PackageDependencyInfo }) {
  if (info.rows.length === 0) return null;
  return (
    <div className="detail-section">
      <div className="dep-section__header">
        <span className="detail-section__title">Dependencies</span>
        <span className="dep-section__context">
          {info.framework}
          {info.selectedAsset ? ` · lib/${info.selectedAsset}` : ''}
        </span>
      </div>
      <div className="dep-list">
        <DependencyRowList rows={info.rows} depth={0} />
      </div>
    </div>
  );
}

function DependencyRowList({ rows, depth }: { rows: DependencyRow[]; depth: number }) {
  return (
    <>
      {rows.map((row) => (
        <React.Fragment key={row.id}>
          <div className={`dep-row${depth > 0 ? ' dep-row--nested' : ''}`}>
            <span className="dep-row__id" title={row.id}>{row.id}</span>
            <span className="dep-row__meta">
              {/* `showDeclared` decides whether the range is worth the space, not
                  the status: a range with a ceiling is a real constraint and is
                  shown even when the resolved version sits happily inside it,
                  while a bare floor that was simply met is noise. "asked X"
                  already carries the range, so it replaces the plain form. */}
              {row.status === 'major-lifted' ? (
                <span className="dep-row__hint">asked {row.declaredRange}</span>
              ) : (
                <>
                  {row.status === 'outside-range' && (
                    <span className="dep-row__bad" aria-hidden="true"><IconMarkWarning /></span>
                  )}
                  {row.showDeclared && <span className="dep-row__range">{row.declaredRange}</span>}
                </>
              )}
              <span className={row.status === 'outside-range' ? 'dep-row__version dep-row__version--bad' : 'dep-row__version'}>
                {row.resolvedVersion ?? '—'}
              </span>
            </span>
          </div>
          {row.children.length > 0 && <DependencyRowList rows={row.children} depth={depth + 1} />}
        </React.Fragment>
      ))}
    </>
  );
}
