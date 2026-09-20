import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { searchableConfigFiles } from '../../searchConfigFiles';
import type { VersionFlag } from '../utils/familyVersionFlags';
import { compatibilityFor, hiddenVersions } from '../utils/versionCompatibility';
import { versionsEqual } from '../../semver';

/** Tooltip text for a version the feed flags — vulnerable and/or deprecated (#86); undefined when neither applies. */
function versionWarningTitle(flags: VersionFlag | undefined): string | undefined {
  if (!flags) return undefined;
  const parts: string[] = [];
  if (flags.vulnerable) parts.push('Flagged vulnerable by the feed');
  if (flags.deprecation) parts.push(`Deprecated: ${flags.deprecation}`);
  if (parts.length === 0) return undefined;
  // A family target applies to several packages at once and is usually flagged
  // for only some of them, so the mark has to say which (#92).
  if (flags.packages?.length) parts.push(flags.packages.join(', '));
  return parts.join(' — ');
}

/** Leading major of a version, or undefined when it does not start with digits. */
function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version.trim());
  return m ? parseInt(m[1], 10) : undefined;
}

export function VersionSelect({
  versions,
  selected,
  onChange,
  disabled,
  label,
  versionFlags,
  versionLine,
  projectTfms,
}: {
  versions: string[];
  selected: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
  /** Vulnerable/deprecated marks per version, from the feed — shown before a version is even chosen (#86). */
  versionFlags?: Record<string, VersionFlag>;
  /**
   * A version whose major line this picker belongs to (#82). Options outside it
   * are set apart and annotated rather than removed: a per-framework pin exists
   * to keep one target inside its line, but crossing a major deliberately is
   * still a legitimate thing to do — it is doing it by accident that is not.
   */
  versionLine?: string;
  /**
   * The target framework(s) this picker installs into (#107). A version the
   * feed declares no compatible group for is collapsed behind a disclosure
   * rather than dimmed in place — undefined/empty leaves every version exactly
   * as offered today, which is what a caller with nothing to judge by passes.
   */
  projectTfms?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [disclosed, setDisclosed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const firstHiddenRef = useRef<HTMLButtonElement>(null);
  const options = versions.length > 0 ? versions : (selected ? [selected] : []);
  const empty = options.length === 0;
  const selectedWarning = versionWarningTitle(versionFlags?.[selected]);
  const line = versionLine === undefined ? undefined : majorOf(versionLine);

  // The selected version — even one reached through the disclosure itself,
  // or one installed before the feed ever described its frameworks — always
  // stays in the visible list: a picker that hides its own current value on
  // open would be worse than one that never learned to dim anything at all.
  const compat = compatibilityFor(options, versionFlags, projectTfms);
  const hiddenSet = new Set(hiddenVersions(compat, selected));
  const visibleOptions = options.filter((v) => !hiddenSet.has(v));
  const hiddenOptions = options.filter((v) => hiddenSet.has(v));
  const optionsKey = options.join(' ');

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

  // Collapsed again for a version list this picker has not seen before —
  // otherwise switching packages while the section happened to be open would
  // carry that state to a package whose reader never asked for it.
  useEffect(() => { setDisclosed(false); }, [optionsKey]);

  // The disclosure sits pinned to the bottom of the dropdown precisely so it
  // never needs scrolling to reach — but the versions it reveals render
  // *below* it in the flow, off-screen in exactly the same way, unless the
  // dropdown scrolls to meet them. To the *start* of that new section, not to
  // the bottom of the whole list: a package with many hidden versions would
  // otherwise land on the very last of them, with every other newly-revealed
  // one sitting above, unseen, exactly the scroll this exists to avoid.
  // Before paint, so the reader never sees the still-scrolled-up frame first.
  useLayoutEffect(() => {
    if (!disclosed) return;
    firstHiddenRef.current?.scrollIntoView({ block: 'start' });
  }, [disclosed]);

  const renderOption = (v: string, i: number, forcedOffLine: boolean, ref?: React.Ref<HTMLButtonElement>) => {
    const warning = versionWarningTitle(versionFlags?.[v]);
    const incompatReason = compat.reason(v);
    const outside = forcedOffLine || (line !== undefined && majorOf(v) !== line);
    // The first option that leaves the line gets the rule above it, so the
    // two halves of the list read as two halves — and the first version the
    // disclosure reveals needs exactly the same rule for exactly the same
    // reason (#107): the disclosure button that used to mark this boundary
    // is itself gone once expanded, replaced in the flow by these options,
    // and dimming alone does not draw a line between two dimmed things.
    const firstOutside = forcedOffLine ? i === 0 : (outside && (i === 0 || majorOf(visibleOptions[i - 1]) === line));
    return (
      <button
        key={v}
        ref={ref}
        type="button"
        role="option"
        aria-selected={versionsEqual(v, selected)}
        className={[
          'version-select__option',
          versionsEqual(v, selected) ? 'version-select__option--selected' : '',
          outside ? 'version-select__option--off-line' : '',
          firstOutside ? 'version-select__option--line-break' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={[
          v,
          // A version that is both outside the major line and off-framework
          // needs only one explanation: what stops the reader from using it
          // here is the more concrete fact (#107).
          incompatReason ?? (outside ? `leaves the ${line}.x line` : ''),
          warning ?? '',
        ].filter(Boolean).join(' — ')}
        onClick={() => {
          onChange(v);
          setOpen(false);
        }}
      >
        {v}
        {warning && <span className="version-select__warn" aria-hidden="true"> ⚠</span>}
      </button>
    );
  };

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
        <span className="version-select__value">{selected || '…'}</span>
        {selectedWarning && <span className="version-select__warn" aria-hidden="true">⚠</span>}
        <span className="version-select__arrow" aria-hidden="true">▾</span>
      </button>
      {open && !empty && (
        <div className="version-select__dropdown" role="listbox" aria-label={label} ref={dropdownRef}>
          {visibleOptions.map((v, i) => renderOption(v, i, false))}
          {hiddenOptions.length > 0 && !disclosed && (
            <button
              type="button"
              className="version-select__disclose"
              onClick={() => setDisclosed(true)}
            >
              <span className="version-select__disclose-chev" aria-hidden="true">▸</span>
              {hiddenOptions.length} version{hiddenOptions.length === 1 ? '' : 's'} that can&apos;t install here
            </button>
          )}
          {disclosed && hiddenOptions.map((v, i) => renderOption(v, i, true, i === 0 ? firstHiddenRef : undefined))}
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
  /** See `VersionSelect`'s own prop of the same name (#107). */
  projectTfms?: readonly string[];
}

export function VersionSelector({
  packageId,
  versions,
  selected,
  onChange,
  restoredVersion,
  restoredProjectPath,
  projectTfms,
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
      prerelease,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId, prerelease, configFiles.join(','), restoredVersion, restoredProjectPath]);

  return (
    <VersionSelect
      versions={versions}
      selected={selected}
      versionFlags={state.detail.versionFlags}
      label={`Version for ${packageId}`}
      projectTfms={projectTfms}
      onChange={(v) => {
        onChange(v);
        send({
          type: 'GET_PACKAGE_METADATA', packageId, version: v, configFiles, projectPath: projectPathFor(v), prerelease,
        });
      }}
    />
  );
}
