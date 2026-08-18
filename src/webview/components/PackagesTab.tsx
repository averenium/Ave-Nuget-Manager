import React, { useCallback, useEffect, useRef } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { SourceFilterDropdown } from './SourceFilterDropdown';
import { InstalledList } from './InstalledList';
import { ImplicitList } from './ImplicitList';
import { AvailableList } from './AvailableList';
import { PackageDetailPanel } from './PackageDetailPanel';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export function PackagesTab() {
  const { state, dispatch, send } = useNugetManager();
  const { searchQuery, selectedSources, prerelease, enrichProgress } = state.packages;
  const { allSources } = state.sources;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    (q: string, sources: string[], pr: boolean) => {
      if (q.length < MIN_QUERY_LEN) return;
      send({
        type: 'SEARCH_PACKAGES',
        query: q,
        enabledSourceNames: sources,
        prerelease: pr,
      });
    },
    [send],
  );

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    dispatch({ type: 'SET_SEARCH_QUERY', query: q });
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.length >= MIN_QUERY_LEN) {
      timerRef.current = setTimeout(
        () => doSearch(q, selectedSources, prerelease),
        DEBOUNCE_MS,
      );
    } else {
      dispatch({ type: 'MSG', msg: { type: 'SEARCH_RESULTS', query: q, packages: [] } });
    }
  };

  // Re-search when sources or prerelease toggle changes
  useEffect(() => {
    if (searchQuery.length >= MIN_QUERY_LEN) {
      doSearch(searchQuery, selectedSources, prerelease);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSources.join(','), prerelease]);

  useEffect(
    () => () => { if (timerRef.current) clearTimeout(timerRef.current); },
    [],
  );

  return (
    <div className="packages-tab">
      {/* ── Toolbar: refresh + search + sources + prerelease ── */}
      <div className="pkg-toolbar">
        <button
          className="pkg-toolbar__refresh"
          title="Force refresh (clears cache)"
          aria-label="Force refresh packages"
          onClick={() => send({ type: 'FORCE_REFRESH' })}
        >
          ↺
        </button>

        <input
          type="search"
          className="pkg-toolbar__search"
          placeholder="Search packages… (min 2 chars)"
          value={searchQuery}
          onChange={handleQueryChange}
          aria-label="Search available packages"
        />

        <SourceFilterDropdown
          sources={allSources}
          selected={selectedSources}
          onChange={(s) => dispatch({ type: 'SET_SELECTED_SOURCES', sources: s })}
        />

        {/* Progress indicator — shown while enriching */}
        {enrichProgress && (
          <span className="pkg-toolbar__progress" aria-live="polite">
            {enrichProgress.done}/{enrichProgress.total}
          </span>
        )}

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
      </div>

      {/* ── Split: list left / detail right ── */}
      <div className="pkg-body">
        <div className="packages-left">
          <div className="packages-left__scroll">
            <InstalledList />
            <ImplicitList />
            <AvailableList />
          </div>
        </div>

        <div className="packages-right">
          <PackageDetailPanel />
        </div>
      </div>
    </div>
  );
}
