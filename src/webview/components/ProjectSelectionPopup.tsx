import React, { useState } from 'react';
import type { ProjectInfo } from '../../types';

interface Props {
  title: string;
  projects: ProjectInfo[];
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}

export function ProjectSelectionPopup({ title, projects, onConfirm, onCancel }: Props) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(projects.map((p) => p.absolutePath)),
  );

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const handleConfirm = () => {
    const selected = [...checked];
    if (selected.length === 0) {
      onCancel(); // empty selection → close without command (Req 6.4)
      return;
    }
    onConfirm(selected);
  };

  return (
    <div className="popup-overlay" role="dialog" aria-modal="true" aria-labelledby="popup-title">
      <div className="popup">
        <div className="popup__title" id="popup-title">{title}</div>

        <div className="popup__list">
          {projects.map((p) => (
            <label key={p.absolutePath} className="popup__item">
              <input
                type="checkbox"
                checked={checked.has(p.absolutePath)}
                onChange={() => toggle(p.absolutePath)}
              />
              {p.name}
              <span style={{ color: 'var(--color-tab-inactive)', fontSize: 11, marginLeft: 'auto' }}>
                {p.relativePath}
              </span>
            </label>
          ))}
        </div>

        <div className="popup__actions">
          <button className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={handleConfirm}>Apply</button>
        </div>
      </div>
    </div>
  );
}
