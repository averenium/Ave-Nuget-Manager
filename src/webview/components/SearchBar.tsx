import React, { useCallback, useEffect, useRef } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { searchableConfigFiles } from '../../searchConfigFiles';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export function SearchBar() {
  const { state, dispatch, send } = useNugetManager();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = state.packages.searchQuery;
  const selectedSources = state.packages.selectedSources;
  const configFiles = searchableConfigFiles(state.sources.configChain);

  const doSearch = useCallback(
    (q: string, sources: string[]) => {
      if (q.length < MIN_QUERY_LEN) return;
      send({
        type: 'SEARCH_PACKAGES',
        query: q,
        configFiles,
        enabledSourceNames: sources,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configFiles.join(','), send],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    dispatch({ type: 'SET_SEARCH_QUERY', query: q });

    if (timerRef.current) clearTimeout(timerRef.current);

    if (q.length >= MIN_QUERY_LEN) {
      timerRef.current = setTimeout(() => doSearch(q, selectedSources), DEBOUNCE_MS);
    } else {
      // Clear available list by dispatching empty search results
      dispatch({ type: 'MSG', msg: { type: 'SEARCH_RESULTS', query: q, packages: [] } });
    }
  };

  // Re-search when source filter changes and query is active
  useEffect(() => {
    if (query.length >= MIN_QUERY_LEN) {
      doSearch(query, selectedSources);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSources.join(',')]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div className="search-bar">
      <input
        type="search"
        className="search-bar__input"
        placeholder="Search packages… (min 2 chars)"
        value={query}
        onChange={handleChange}
        aria-label="Search available packages"
      />
    </div>
  );
}
