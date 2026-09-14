import React from 'react';
import type { DeclaredDependencyGroup } from '../../types';
import { frameworkKey } from '../../frameworkMoniker';
import { selectCompatibleGroup } from '../../frameworkCompatibility';
import { sortTargetFrameworksDesc } from '../../targetFrameworks';

interface Props {
  /** What the selected version declares, per framework, as the feed stated it. */
  groups: DeclaredDependencyGroup[];
  /** Every framework the workspace's projects target, newest first. */
  projectFrameworks: string[];
}

/**
 * The dependencies a version *declares*, for a package that is not installed
 * (#114).
 *
 * The resolved tree needs a restore graph, and a package nothing has installed
 * has none — so until now the panel said nothing at all about what an install
 * would pull in. The registration entry states the ranges, and the version walk
 * already downloaded it.
 *
 * These are ranges rather than resolved versions, which the rows show for
 * themselves — `[3.1.0, 4.0.0)` is not a version, and the heading already says
 * "declared". A sentence explaining that competed with the rows it explained and
 * was cut. The section switches to the resolved tree the moment the package is
 * installed: the same rows with one column more, so nothing moves under the
 * reader.
 */
export function DeclaredDependenciesSection({ groups, projectFrameworks }: Props) {
  if (groups.length === 0) return null;
  const target = projectFrameworks[0];
  // The group restore would take, not the one that happens to spell this
  // framework: a package declaring net8.0 and netstandard2.0 serves a net10.0
  // project, and reporting "no group" about it would be a claim, and wrong.
  const group = selectCompatibleGroup(groups, target);
  const declaredFor = frameworkKey(group?.targetFramework);

  return (
    <div className="detail-section">
      <div className="dep-section__header">
        <span className="detail-section__title">Dependencies</span>
        <span className="dep-section__context">
          {!group
            ? `no group for ${target}`
            : !declaredFor
              ? 'declared for any framework'
              : declaredFor === frameworkKey(target)
                ? `declared for ${declaredFor}`
                // Say which group this is when it is not the project's own:
                // the rows below are that group's, and a reader comparing them
                // against their project file has to know which one answered.
                : `declared for ${declaredFor}, nearest to ${target}`}
        </span>
      </div>
      {group ? (
        <div className="dep-list">
          {group.dependencies.length === 0 ? (
            // A group the feed declares empty says something a missing group
            // does not: this version needs nothing for this framework.
            <div className="dep-row dep-row--none">Declares no dependencies for this framework</div>
          ) : group.dependencies.map((dependency) => (
            <div className="dep-row" key={dependency.id}>
              <span className="dep-row__id" title={dependency.id}>{dependency.id}</span>
              <span className="dep-row__meta">
                <span className="dep-row__range">{dependency.range ?? 'any version'}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        /* The one finding worth stating carefully. A package may ship assets for
           a framework it declares no dependencies for, so this reports what the
           feed said and stops — it is not a verdict on compatibility, which is
           restore's to give. */
        <div className="dep-section__note">
          The feed declares dependency groups for{' '}
          {/* Spelled the way the project file spells them, and separated in the
              text itself — run together they read as one impossible moniker. */}
          {declaredFrameworks(groups).map((tfm, at) => (
            <React.Fragment key={tfm}>
              {at > 0 && ', '}
              <span className="badge badge--dim">{tfm}</span>
            </React.Fragment>
          ))}{' '}
          only. That usually means no assets for this project&rsquo;s framework — but a package
          can ship a framework it declares no dependencies for, so this says what the feed said
          and leaves the verdict to restore.
        </div>
      )}
    </div>
  );
}

/** The frameworks the feed named, in the order the badges elsewhere use. */
function declaredFrameworks(groups: DeclaredDependencyGroup[]): string[] {
  const named = groups.map((g) => frameworkKey(g.targetFramework)).filter(Boolean);
  return sortTargetFrameworksDesc([...new Set(named)]);
}
