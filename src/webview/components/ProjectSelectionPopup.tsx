import React, { useMemo, useState } from 'react';
import type { ProjectInfo } from '../../types';
import { compareSemVer } from '../utils/search';

interface Props {
  title: string;
  projects: ProjectInfo[];
  /** Paths checked on open. Defaults to every project in `projects`. */
  initiallySelected?: string[];
  /** Current resolved version per project path. */
  currentVersions?: Record<string, string>;
  /** Version that will be installed/updated. Omit for remove. */
  targetVersion?: string;
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}

type VersionTone = 'up' | 'down' | 'same' | 'add';

function versionTone(from: string | undefined, to: string | undefined): VersionTone | undefined {
  if (from && to) {
    const cmp = compareSemVer(to, from);
    if (cmp > 0) return 'up';
    if (cmp < 0) return 'down';
    return 'same';
  }
  if (!from && to) return 'add';
  return undefined;
}

function versionLabel(from: string | undefined, to: string | undefined): string | undefined {
  if (from && to && from !== to) return `${from} → ${to}`;
  if (from && to) return from;
  if (from) return from;
  if (to) return `+ ${to}`;
  return undefined;
}

export function ProjectSelectionPopup({
  title, projects, initiallySelected, currentVersions, targetVersion, onConfirm, onCancel,
}: Props) {
  const installedSet = useMemo(
    () => new Set(Object.keys(currentVersions ?? {})),
    [currentVersions],
  );

  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(initiallySelected ?? projects.map((p) => p.absolutePath)),
  );
  const [query, setQuery] = useState('');

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
      next.has(path) ? next.delete(path) : next.add(path);
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
    onConfirm(selected);
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

            return (
              <label
                key={p.absolutePath}
                className={rowClass}
                title={`${p.name}\n${p.relativePath}${label ? `\n${label}` : ''}`}
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
