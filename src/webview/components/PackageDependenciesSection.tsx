import type { DependencyRow, PackageDependencyInfo } from '../../types';
import { IconMarkWarning } from '../utils/icons';
import { dependencyRowParts } from '../utils/dependencyRowParts';
import { DependencyTree } from './DependencyTree';

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
        <DependencyTree rows={info.rows} renderRow={renderDependency} dimNested />
      </div>
    </div>
  );
}

function renderDependency(row: DependencyRow) {
  const parts = dependencyRowParts(row);
  return (
    <>
      <span className="dep-row__id" title={row.id}>{row.id}</span>
      <span className="dep-row__meta">
        {parts.hint ? (
          <span className="dep-row__hint">{parts.hint}</span>
        ) : (
          <>
            {parts.warning && (
              <span className="dep-row__bad" aria-hidden="true"><IconMarkWarning /></span>
            )}
            {parts.range && <span className="dep-row__range">{parts.range}</span>}
          </>
        )}
        <span className={parts.versionBad ? 'dep-row__version dep-row__version--bad' : 'dep-row__version'}>
          {parts.version}
        </span>
      </span>
    </>
  );
}
