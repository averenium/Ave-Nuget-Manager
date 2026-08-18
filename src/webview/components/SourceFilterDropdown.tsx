import React, { useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { PackageSource } from '../../types';

interface Props {
  sources: PackageSource[];
  selected: string[];
  onChange: (names: string[]) => void;
}

export function SourceFilterDropdown({ sources, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const label =
    selected.length === 0
      ? 'No sources selected'
      : selected.length === sources.length
        ? 'All sources'
        : `${selected.length} source${selected.length > 1 ? 's' : ''}`;

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="source-filter">
      <button
        className="source-filter__btn"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
      >
        🔍 {label} ▾
      </button>

      {open && (
        <div className="source-filter__dropdown" role="listbox" aria-multiselectable="true">
          {sources.length === 0 && (
            <div className="source-filter__warning">No sources configured</div>
          )}
          {sources.map((src) => (
            <label key={src.name} className="source-filter__item">
              <input
                type="checkbox"
                checked={selected.includes(src.name)}
                onChange={() => toggle(src.name)}
                aria-label={src.name}
              />
              {src.name}
            </label>
          ))}
        </div>
      )}

      {selected.length === 0 && sources.length > 0 && (
        <div className="source-filter__warning" role="alert">
          ⚠ No sources selected — search results will be empty.
        </div>
      )}
    </div>
  );
}
