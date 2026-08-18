import React, { useEffect, useRef } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

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
  const loadedFor = useRef<string>(''); // track which packageId versions were last requested

  // Trigger background version load when packageId or prerelease changes.
  // Does NOT block the UI — versions arrive asynchronously via ALL_VERSIONS message.
  useEffect(() => {
    if (!packageId || configFiles.length === 0) return;
    const key = `${packageId}::${prerelease}`;
    if (loadedFor.current === key) return; // already requested, avoid duplicate
    loadedFor.current = key;

    // Fire-and-forget — result comes back via ALL_VERSIONS → reducer → re-render
    send({ type: 'GET_ALL_VERSIONS', packageId, configFiles, prerelease });
    // Also load metadata in background
    send({ type: 'GET_PACKAGE_METADATA', packageId, configFiles });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId, prerelease, configFiles.join(',')]);

  // When user manually picks a version, reload metadata for that version
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    onChange(v);
    send({ type: 'GET_PACKAGE_METADATA', packageId, version: v, configFiles });
  };

  // Show installed version as placeholder while versions are loading in background
  const placeholder = selected || '…';

  if (versions.length === 0) {
    return (
      <select disabled aria-label={`Version for ${packageId}`}>
        <option>{placeholder}</option>
      </select>
    );
  }

  return (
    <select
      value={selected}
      onChange={handleChange}
      aria-label={`Version for ${packageId}`}
    >
      {versions.map((v) => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  );
}
