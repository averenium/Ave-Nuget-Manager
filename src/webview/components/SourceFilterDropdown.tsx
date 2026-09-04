import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { PackageSource } from '../../types';

interface Props {
  sources: PackageSource[];
  selected: string[];
  onChange: (names: string[]) => void;
}

export function SourceFilterDropdown({ sources, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Nothing closed this except the toggle button itself, so it stayed open
  // over the package list below it after clicking anywhere else — same
  // outside-click/Escape pattern already used by SourceUrlMenu (#70).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

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
    <div className="source-filter" ref={rootRef}>
      <button
        className="source-filter__btn"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={label}
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
            <label key={src.name} className="source-filter__item" title={src.name}>
              <input
                type="checkbox"
                checked={selected.includes(src.name)}
                onChange={() => toggle(src.name)}
                aria-label={src.name}
              />
              <span className="source-filter__name">{src.name}</span>
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
