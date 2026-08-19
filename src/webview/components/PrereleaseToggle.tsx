import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';

export function PrereleaseToggle() {
  const { state, dispatch, send } = useNugetManager();
  const { prerelease } = state.packages;
  return (
    <label className="pkg-toolbar__prerelease">
      <input
        type="checkbox"
        checked={prerelease}
        onChange={(e) => {
          dispatch({ type: 'SET_PRERELEASE', prerelease: e.target.checked });
          send({ type: 'SET_PRERELEASE_SETTING', prerelease: e.target.checked });
        }}
      />
      Pre-release
    </label>
  );
}
