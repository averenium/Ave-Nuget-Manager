import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

export function VersionSelect({
  versions,
  selected,
  onChange,
  disabled,
  label,
}: {
  versions: string[];
  selected: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = versions.length > 0 ? versions : (selected ? [selected] : []);
  const empty = options.length === 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="version-select" ref={rootRef}>
      <button
        type="button"
        className="version-select__btn"
        disabled={disabled || empty}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected || label}
        onClick={() => setOpen((v) => !v)}
      >
        {selected || '…'}
      </button>
      {open && !empty && (
        <div className="version-select__dropdown" role="listbox" aria-label={label}>
          {options.map((v) => (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={v === selected}
              className={['version-select__option', v === selected ? 'version-select__option--selected' : '']
                .filter(Boolean)
                .join(' ')}
              title={v}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  packageId: string;
  versions: string[];
  selected: string;
  onChange: (v: string) => void;
}

export function VersionSelector({ packageId, versions, selected, onChange }: Props) {
  const { send, state } = useNugetManager();
  const configFiles = state.sources.configChain.map((c) => c.filePath);
  const { prerelease } = state.packages;
  const loadedFor = useRef<string>('');

  useEffect(() => {
    if (!packageId || configFiles.length === 0) return;
    const key = `${packageId}::${prerelease}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    send({ type: 'GET_ALL_VERSIONS', packageId, configFiles, prerelease });
    send({ type: 'GET_PACKAGE_METADATA', packageId, configFiles });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId, prerelease, configFiles.join(',')]);

  return (
    <VersionSelect
      versions={versions}
      selected={selected}
      label={`Version for ${packageId}`}
      onChange={(v) => {
        onChange(v);
        send({ type: 'GET_PACKAGE_METADATA', packageId, version: v, configFiles });
      }}
    />
  );
}
