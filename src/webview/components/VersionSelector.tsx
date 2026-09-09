import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { searchableConfigFiles } from '../../searchConfigFiles';

/** Tooltip text for a version the feed flags — vulnerable and/or deprecated (#86); undefined when neither applies. */
function versionWarningTitle(flags: { vulnerable?: boolean; deprecation?: string } | undefined): string | undefined {
  if (!flags) return undefined;
  const parts: string[] = [];
  if (flags.vulnerable) parts.push('Flagged vulnerable by the feed');
  if (flags.deprecation) parts.push(`Deprecated: ${flags.deprecation}`);
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

export function VersionSelect({
  versions,
  selected,
  onChange,
  disabled,
  label,
  versionFlags,
}: {
  versions: string[];
  selected: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
  /** Vulnerable/deprecated marks per version, from the feed — shown before a version is even chosen (#86). */
  versionFlags?: Record<string, { vulnerable?: boolean; deprecation?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = versions.length > 0 ? versions : (selected ? [selected] : []);
  const empty = options.length === 0;
  const selectedWarning = versionWarningTitle(versionFlags?.[selected]);

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
        title={selectedWarning ? `${selected} — ${selectedWarning}` : (selected || label)}
        onClick={() => setOpen((v) => !v)}
      >
        {selected || '…'}
        {selectedWarning && <span className="version-select__warn" aria-hidden="true"> ⚠</span>}
      </button>
      {open && !empty && (
        <div className="version-select__dropdown" role="listbox" aria-label={label}>
          {options.map((v) => {
            const warning = versionWarningTitle(versionFlags?.[v]);
            return (
              <button
                key={v}
                type="button"
                role="option"
                aria-selected={v === selected}
                className={['version-select__option', v === selected ? 'version-select__option--selected' : '']
                  .filter(Boolean)
                  .join(' ')}
                title={warning ? `${v} — ${warning}` : v}
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
              >
                {v}
                {warning && <span className="version-select__warn" aria-hidden="true"> ⚠</span>}
              </button>
            );
          })}
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
  /** Version the restore put on disk for this package — direct or transitive — enabling the local-.nuspec path (#86) when the requested version matches it exactly. */
  restoredVersion?: string;
  /** Project whose local NuGet cache to check for `restoredVersion`'s .nuspec. Only meaningful together with `restoredVersion`. */
  restoredProjectPath?: string;
}

export function VersionSelector({
  packageId,
  versions,
  selected,
  onChange,
  restoredVersion,
  restoredProjectPath,
}: Props) {
  const { send, state } = useNugetManager();
  const configFiles = searchableConfigFiles(state.sources.configChain);
  const { prerelease } = state.packages;
  const loadedFor = useRef<string>('');

  // Only pass `projectPath` when `version` is exactly what the restore put
  // there — a different version (or nothing restored) must fall back to the
  // search response, never a stale/mismatched nuspec.
  const projectPathFor = (version: string | undefined): string | undefined =>
    version && restoredVersion && version === restoredVersion ? restoredProjectPath : undefined;

  useEffect(() => {
    if (!packageId || configFiles.length === 0) return;
    const key = `${packageId}::${prerelease}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    send({ type: 'GET_ALL_VERSIONS', packageId, configFiles, prerelease });
    send({
      type: 'GET_PACKAGE_METADATA',
      packageId,
      configFiles,
      version: restoredVersion || undefined,
      projectPath: projectPathFor(restoredVersion),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId, prerelease, configFiles.join(','), restoredVersion, restoredProjectPath]);

  return (
    <VersionSelect
      versions={versions}
      selected={selected}
      versionFlags={state.detail.versionFlags}
      label={`Version for ${packageId}`}
      onChange={(v) => {
        onChange(v);
        send({ type: 'GET_PACKAGE_METADATA', packageId, version: v, configFiles, projectPath: projectPathFor(v) });
      }}
    />
  );
}
