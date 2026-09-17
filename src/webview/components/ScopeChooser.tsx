import React, { useEffect, useMemo, useState } from 'react';
import { matchesQuery } from '../utils/search';
import { pathsEqual } from '../../pathCompare';
import { litProjectPathsFor, isProjectDimmed } from '../utils/scopeChooserHighlight';
import type { ScopeChoices, ScopeChoiceProject } from '../../types';

const PROJECTS_SHOWN_INITIALLY = 8;

export type ScopePickTarget = { kind: 'file'; path: string } | { kind: 'folder' };

interface Props {
  choices: ScopeChoices;
  /** Identity path of the live scope — marks its row "current" and lights up its projects. `null` on first open, when there is nothing yet to mark. */
  currentPath: string | null;
  /** Its display name, for the back button ("← Keep Example.Shop.sln"). Unused when `currentPath` is null. */
  currentLabel: string;
  /** True once there is an existing scope behind the chooser — narrower columns, current-scope mark, a way back. */
  tight: boolean;
  onPick: (target: ScopePickTarget) => void;
  /** Only called in `tight` mode — first-open has no closed state to return to. */
  onClose?: () => void;
}

function dirOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash + 1);
}

function projectMatches(project: ScopeChoiceProject, query: string): boolean {
  return matchesQuery(project.name, query) || matchesQuery(project.relativePath, query);
}

export function ScopeChooser({ choices, currentPath, currentLabel, tight, onPick, onClose }: Props) {
  const [hoveredSolution, setHoveredSolution] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showAllProjects, setShowAllProjects] = useState(false);

  useEffect(() => {
    if (!tight || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tight, onClose]);

  const litProjectPaths = useMemo(
    () => litProjectPathsFor(choices.solutions, hoveredSolution),
    [hoveredSolution, choices.solutions],
  );

  const filteredProjects = useMemo(
    () => (filter.trim() ? choices.projects.filter((p) => projectMatches(p, filter)) : choices.projects),
    [choices.projects, filter],
  );
  const visibleProjects = showAllProjects || filter.trim()
    ? filteredProjects
    : filteredProjects.slice(0, PROJECTS_SHOWN_INITIALLY);
  const remaining = filteredProjects.length - visibleProjects.length;

  const pickFile = (path: string) => {
    if (currentPath && pathsEqual(path, currentPath)) {
      onClose?.();
      return;
    }
    onPick({ kind: 'file', path });
  };

  const pickFolder = () => {
    if (currentPath && pathsEqual(currentPath, choices.folderPath)) {
      onClose?.();
      return;
    }
    onPick({ kind: 'folder' });
  };

  const folderCovers = choices.solutions.length > 0 ? 'ignores solution boundaries' : 'no solution here';
  const summary = choices.solutions.length > 0
    ? `This folder holds ${choices.solutions.length} solution${choices.solutions.length === 1 ? '' : 's'} and ${choices.totalProjects} project${choices.totalProjects === 1 ? '' : 's'}.`
    : `This folder holds ${choices.totalProjects} project${choices.totalProjects === 1 ? '' : 's'} and no solution.`;

  return (
    <div className={`scope-chooser${tight ? ' scope-chooser--tight' : ''}`}>
      <div className="scope-chooser__head">
        <div>
          <h3 className="scope-chooser__title">Choose what to manage</h3>
          {!tight && <p className="scope-chooser__summary">{summary}</p>}
        </div>
        {tight && onClose && (
          <div className="scope-chooser__back">
            <button type="button" className="scope-chooser__back-btn" onClick={onClose}>
              ← Keep {currentLabel}
            </button>
            <span className="scope-chooser__back-kbd">Esc</span>
          </div>
        )}
      </div>

      <div className="scope-chooser__cols">
        <div className="scope-chooser__col scope-chooser__col--left">
          {choices.solutions.length > 0 && (
            <>
              <div className="scope-chooser__group">Solutions</div>
              {choices.solutions.map((s, i) => {
                const isCurrent = currentPath !== null && pathsEqual(s.path, currentPath);
                return (
                  <div
                    key={s.path}
                    role="button"
                    tabIndex={0}
                    className={
                      'scope-chooser__opt'
                      + (isCurrent ? ' scope-chooser__opt--current' : '')
                      + (!isCurrent && i === 0 && !tight ? ' scope-chooser__opt--likely' : '')
                    }
                    onMouseEnter={() => setHoveredSolution(s.path)}
                    onMouseLeave={() => setHoveredSolution((h) => (h === s.path ? null : h))}
                    onClick={() => pickFile(s.path)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(s.path); } }}
                  >
                    <span className="scope-chooser__ico" aria-hidden="true">▤</span>
                    <span className="scope-chooser__name">{s.path.split(/[\\/]/).pop()}</span>
                    {isCurrent ? (
                      <span className="scope-chooser__mark">✓ current</span>
                    ) : (
                      <span className="scope-chooser__covers">{s.projectCount} project{s.projectCount === 1 ? '' : 's'}</span>
                    )}
                    <span className="scope-chooser__where">{s.relativeDir ? `${s.relativeDir}/` : './'}</span>
                  </div>
                );
              })}
            </>
          )}

          {choices.offerAllProjects && (
            <>
              <div className="scope-chooser__group scope-chooser__group--later">Everything</div>
              {(() => {
                const isCurrent = currentPath !== null && pathsEqual(currentPath, choices.folderPath);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    className={
                      'scope-chooser__opt'
                      + (isCurrent ? ' scope-chooser__opt--current' : '')
                      + (choices.solutions.length === 0 && !tight ? ' scope-chooser__opt--likely' : '')
                    }
                    onClick={pickFolder}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFolder(); } }}
                  >
                    <span className="scope-chooser__ico" aria-hidden="true">🗀</span>
                    <span className="scope-chooser__name">All {choices.totalProjects} projects</span>
                    {isCurrent ? (
                      <span className="scope-chooser__mark">✓ current</span>
                    ) : (
                      <span className="scope-chooser__covers">{folderCovers}</span>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </div>

        <div className="scope-chooser__col scope-chooser__col--right">
          <div className="scope-chooser__group">Or one project — {choices.totalProjects}</div>
          <input
            type="search"
            className="scope-chooser__filter"
            placeholder="Filter projects…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter projects"
          />
          {visibleProjects.map((p) => {
            const isCurrent = currentPath !== null && pathsEqual(p.path, currentPath);
            const dim = isProjectDimmed(litProjectPaths, p.path);
            return (
              <div
                key={p.path}
                role="button"
                tabIndex={0}
                className={
                  'scope-chooser__opt'
                  + (isCurrent ? ' scope-chooser__opt--current' : '')
                  + (dim ? ' scope-chooser__opt--dim' : '')
                }
                onClick={() => pickFile(p.path)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(p.path); } }}
              >
                <span className="scope-chooser__ico" aria-hidden="true">▷</span>
                <span className="scope-chooser__name">{p.name}</span>
                {isCurrent && <span className="scope-chooser__mark">✓ current</span>}
                {!tight && <span className="scope-chooser__where">{dirOf(p.relativePath)}</span>}
              </div>
            );
          })}
          {remaining > 0 && (
            <button type="button" className="scope-chooser__more" onClick={() => setShowAllProjects(true)}>
              ▾ {remaining} more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
