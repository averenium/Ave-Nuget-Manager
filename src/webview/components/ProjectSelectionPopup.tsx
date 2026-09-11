import React, { useMemo, useState } from 'react';
import type { ProjectInfo } from '../../types';
import { versionTone, versionLabel } from '../utils/versionTone';


interface Props {
  title: string;
  projects: ProjectInfo[];
  /** Paths checked on open. Defaults to every project in `projects`. */
  initiallySelected?: string[];
  /** Current resolved version per project path. */
  currentVersions?: Record<string, string>;
  /** Version that will be installed/updated. Omit for remove. */
  targetVersion?: string;
  /**
   * Target frameworks each project declares (#82). A project with more than one
   * shows them as badges and can be narrowed to some of them; a project with one
   * framework shows nothing new. Omitted for remove: `dotnet remove package` has
   * no `--framework`, so removal is always project-wide.
   */
  frameworksByProject?: Record<string, string[]>;
  /**
   * Projects whose single reference would have to be split for a narrowing to
   * mean anything (#82). Those rows say so as soon as a badge goes off, since
   * the change is to the shape of the project file and not just to a version.
   */
  splitsReference?: string[];
  onConfirm: (selected: string[], frameworks?: Record<string, string[]>) => void;
  onCancel: () => void;
}

export function ProjectSelectionPopup({
  title, projects, initiallySelected, currentVersions, targetVersion, frameworksByProject,
  splitsReference, onConfirm, onCancel,
}: Props) {
  const installedSet = useMemo(
    () => new Set(Object.keys(currentVersions ?? {})),
    [currentVersions],
  );

  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(initiallySelected ?? projects.map((p) => p.absolutePath)),
  );
  const [query, setQuery] = useState('');
  /**
   * Frameworks switched off for a project (#82). Empty is the ordinary state —
   * every framework lit, which writes one plain reference the way it always
   * did. Kept as what is *off* so a project that never touches these badges
   * carries nothing at all.
   */
  const [offByProject, setOffByProject] = useState<Record<string, string[]>>({});

  const toggleFramework = (projectPath: string, framework: string, all: string[]) => {
    setOffByProject((current) => {
      const off = current[projectPath] ?? [];
      const next = off.includes(framework)
        ? off.filter((f) => f !== framework)
        : [...off, framework];
      // The last one cannot be switched off: a project with no framework at all
      // is an unchecked project, and the checkbox already says that.
      if (next.length >= all.length) return current;
      const updated = { ...current };
      if (next.length === 0) delete updated[projectPath];
      else updated[projectPath] = next;
      return updated;
    });
  };

  const sorted = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aIn = installedSet.has(a.absolutePath) ? 0 : 1;
      const bIn = installedSet.has(b.absolutePath) ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [projects, installedSet]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((p) =>
      p.name.toLowerCase().includes(q) || p.relativePath.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const showTools = projects.length >= 6;
  const upgradeCount = projects.filter((p) =>
    versionTone(currentVersions?.[p.absolutePath], targetVersion) === 'up',
  ).length;

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectVisible = (mode: 'all' | 'none' | 'installed') => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of visible) {
        if (mode === 'all') next.add(p.absolutePath);
        else if (mode === 'none') next.delete(p.absolutePath);
        else if (installedSet.has(p.absolutePath)) next.add(p.absolutePath);
        else next.delete(p.absolutePath);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selected = [...checked];
    if (selected.length === 0) {
      onCancel();
      return;
    }
    // Only the projects actually going out carry a framework choice — one made
    // and then unchecked would otherwise travel with the message (#82).
    // Only a project narrowed to a subset travels with a framework list; the
    // rest are written plainly, which is what keeps an ordinary install from
    // growing conditional groups (#82).
    const frameworks = Object.fromEntries(
      selected
        .map((path) => {
          const all = frameworksByProject?.[path] ?? [];
          const off = offByProject[path] ?? [];
          const on = all.filter((f) => !off.includes(f));
          return [path, off.length > 0 && on.length > 0 ? on : undefined];
        })
        .filter(([, on]) => !!on) as Array<[string, string[]]>,
    );
    onConfirm(selected, Object.keys(frameworks).length > 0 ? frameworks : undefined);
  };

  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="popup-title">
      <div className="popup">
        <div className="popup__title" id="popup-title" title={title}>{title}</div>

        {showTools && (
          <div className="popup__tools">
            <input
              type="search"
              className="popup__search"
              placeholder="Filter projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter projects"
            />
            <div className="popup__bulk">
              <button type="button" className="popup__bulk-btn" onClick={() => selectVisible('installed')}>
                Installed
              </button>
              <button type="button" className="popup__bulk-btn" onClick={() => selectVisible('all')}>
                All
              </button>
              <button type="button" className="popup__bulk-btn" onClick={() => selectVisible('none')}>
                None
              </button>
            </div>
          </div>
        )}

        <div className="popup__meta">
          {checked.size} selected
          {upgradeCount > 0 && ` · ${upgradeCount} to update`}
          {query && ` · ${visible.length} shown`}
        </div>

        <div className="popup__list">
          {visible.length === 0 ? (
            <div className="empty-state">No matching projects</div>
          ) : visible.map((p) => {
            const from = currentVersions?.[p.absolutePath];
            const tone = versionTone(from, targetVersion);
            const label = versionLabel(from, targetVersion);
            const rowClass = [
              'popup__item',
              tone === 'up' ? 'popup__item--up' : '',
              tone === 'down' ? 'popup__item--down' : '',
            ].filter(Boolean).join(' ');

            const frameworks = frameworksByProject?.[p.absolutePath] ?? [];
            const off = offByProject[p.absolutePath] ?? [];
            const showFrameworks = !!targetVersion && frameworks.length > 1;
            const willSplit = off.length > 0
              && off.length < frameworks.length
              && !!splitsReference?.includes(p.absolutePath);

            return (
              <label
                key={p.absolutePath}
                className={rowClass}
                title={[p.name, p.relativePath, label].filter(Boolean).join('\n')}
              >
                <input
                  type="checkbox"
                  checked={checked.has(p.absolutePath)}
                  onChange={() => toggle(p.absolutePath)}
                />
                <span className="popup__item-text">
                  <span className="popup__item-name">
                    <span className="popup__item-name-text">{p.name}</span>
                    {label && (
                      <span className={`popup__ver${tone ? ` popup__ver--${tone}` : ''}`}>
                        {label}
                      </span>
                    )}
                  </span>
                  <span className="popup__item-path">{p.relativePath}</span>
                  {showFrameworks && (
                    // Visible rather than hidden behind a right-click: a project
                    // targeting several frameworks can take the package into
                    // some of them, and nothing else on screen would say so
                    // (#82). Every badge lit is the ordinary install.
                    <span className="popup__item-tfms">
                      {frameworks.map((framework) => {
                        const on = !off.includes(framework);
                        return (
                          <button
                            key={framework}
                            type="button"
                            className={`popup__tfm${on ? ' popup__tfm--on' : ''}`}
                            aria-pressed={on}
                            title={on
                              ? `Installing into ${framework} — click to leave it out`
                              : `Not installing into ${framework} — click to put it back`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleFramework(p.absolutePath, framework, frameworks);
                            }}
                          >{framework}</button>
                        );
                      })}
                    </span>
                  )}
                  {willSplit && (
                    // Said here, beside the badge that causes it, rather than
                    // only in the confirmation this row will raise on Apply.
                    <span className="popup__item-split">splits the shared reference</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <div className="popup__actions">
          <button className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={handleConfirm}>Apply</button>
        </div>


      </div>
    </div>
  );
}
