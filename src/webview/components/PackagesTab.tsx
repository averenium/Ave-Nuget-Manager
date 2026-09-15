import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { SourceFilterDropdown } from './SourceFilterDropdown';
import { InstalledList } from './InstalledList';
import { ImplicitList } from './ImplicitList';
import { AvailableList } from './AvailableList';
import { PackageDetailPanel } from './PackageDetailPanel';
import { SplitPane } from './SplitPane';
import { measureTextWidth } from '../utils/measureText';
import { matchesQuery, normalizeQuery } from '../utils/search';
import { PrereleaseToggle } from './PrereleaseToggle';
import { ToolbarRestoreRefresh } from './ToolbarRestoreRefresh';
import { ActivityStrip } from './ActivityStrip';
import { useFocusSearchOnFind } from '../utils/useFocusSearchOnFind';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
const DEFAULT_LIST_RATIO = 0.5;
const MIN_LIST_PX = 160;
const MIN_DETAIL_PX = 180;
const LIST_ROW_CHROME_PX = 50;
const TITLE_GAP_PX = 6;

/** Unique ids in a list, the number the section header shows as its total. */
function uniqueCount(packages: ReadonlyArray<{ id: string }>): number {
  return new Set(packages.map((p) => p.id.toLowerCase())).size;
}

/** Unique ids the query keeps — what the section header shows before the slash. */
function countMatching(packages: ReadonlyArray<{ id: string }>, query: string): number {
  return new Set(
    packages.filter((p) => matchesQuery(p.id, query)).map((p) => p.id.toLowerCase()),
  ).size;
}

export function PackagesTab() {
  const { state, dispatch, send } = useNugetManager();
  const { searchQuery, selectedSources, prerelease, enrichProgress, installed, implicit, available } = state.packages;
  const { allSources } = state.sources;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnFind(searchRef);
  const [autoListWidthPx, setAutoListWidthPx] = useState<number | null>(null);

  const titleRows = useMemo(() => {
    const byId = new Map<string, string>();
    const add = (id: string, source?: string) => {
      const src = (source ?? '').toLowerCase();
      const prev = byId.get(id) ?? '';
      if (!byId.has(id) || src.length > prev.length) byId.set(id, src);
    };
    for (const pkg of installed) add(pkg.id, pkg.sourceName);
    for (const pkg of implicit) add(pkg.id);
    for (const pkg of available) add(pkg.id, pkg.sourceName);
    return [...byId.entries()].map(([id, source]) => ({ id, source }));
  }, [installed, implicit, available]);

  const doSearch = useCallback(
    (q: string, sources: string[], pr: boolean) => {
      if (normalizeQuery(q).length < MIN_QUERY_LEN) return;
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
    // Kept exactly as typed — trimming it here would delete a trailing space
    // the reader is still typing through (#120). Everything downstream reads
    // the normalised form instead.
    const q = e.target.value;
    dispatch({ type: 'SET_SEARCH_QUERY', query: q });
    if (timerRef.current) clearTimeout(timerRef.current);
    if (normalizeQuery(q).length >= MIN_QUERY_LEN) {
      timerRef.current = setTimeout(
        () => {
          // Logged from here, not from the search itself: this is the query the
          // panel is filtering its own lists by, and how those lists read under
          // it. A search that finds nothing locally looks the same in the log as
          // one that was never given the text — unless both are recorded.
          send({
            type: 'WEBVIEW_ACTION',
            action: 'search',
            query: q,
            counts: {
              installed: [countMatching(installed, q), uniqueCount(installed)],
              implicit: [countMatching(implicit, q), uniqueCount(implicit)],
              available: available.length,
            },
          });
          doSearch(q, selectedSources, prerelease);
        },
        DEBOUNCE_MS,
      );
    } else {
      dispatch({ type: 'MSG', msg: { type: 'SEARCH_RESULTS', query: q, packages: [] } });
    }
  };

  useEffect(() => {
    if (normalizeQuery(searchQuery).length >= MIN_QUERY_LEN) {
      doSearch(searchQuery, selectedSources, prerelease);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSources.join(','), prerelease]);

  useEffect(
    () => () => { if (timerRef.current) clearTimeout(timerRef.current); },
    [],
  );

  useEffect(() => {
    const el = tabRef.current;
    if (!el) return;

    const apply = () => {
      const bodyWidth = el.clientWidth;
      if (bodyWidth <= 0) return;
      const cap = Math.floor(bodyWidth * DEFAULT_LIST_RATIO);
      const max = Math.max(MIN_LIST_PX, bodyWidth - MIN_DETAIL_PX);
      const cs = getComputedStyle(el);
      const nameFont = `500 ${cs.fontSize} ${cs.fontFamily}`;
      const sourceFont = `10px ${cs.fontFamily}`;
      let contentW = 0;
      for (const row of titleRows) {
        let w = measureTextWidth(row.id, nameFont);
        if (row.source) w += TITLE_GAP_PX + measureTextWidth(row.source, sourceFont);
        if (w > contentW) contentW = w;
      }
      const desired = titleRows.length === 0 ? MIN_LIST_PX : contentW + LIST_ROW_CHROME_PX;
      setAutoListWidthPx(Math.min(max, Math.max(MIN_LIST_PX, Math.round(Math.min(desired, cap)))));
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [titleRows]);

  return (
    <div className="split-tab" ref={tabRef}>
      <div className="pkg-toolbar">
        <ToolbarRestoreRefresh />

        <input
          ref={searchRef}
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

        {enrichProgress && (
          <span className="pkg-toolbar__progress" aria-live="polite">
            {enrichProgress.done}/{enrichProgress.total}
          </span>
        )}

        <PrereleaseToggle />
      </div>
      <ActivityStrip />

      <SplitPane
        autoListWidthPx={autoListWidthPx}
        splitLabel="Resize package list"
        left={
          <>
            <InstalledList />
            <ImplicitList />
            <AvailableList />
          </>
        }
        right={<PackageDetailPanel />}
      />
    </div>
  );
}
