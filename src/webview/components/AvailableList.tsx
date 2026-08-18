import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { PackageRow } from './PackageRow';
import { sortByRelevance } from '../utils/search';

const MIN_QUERY_LEN = 2;

export function AvailableList() {
  const { state, dispatch } = useNugetManager();
  const { available, searchQuery, selectedSources, isSearching } = state.packages;

  if (searchQuery.length < MIN_QUERY_LEN) {
    return null;
  }

  const sorted = sortByRelevance(available, searchQuery);

  return (
    <section className="pkg-section" aria-label="Available packages">
      <div className="pkg-section__header">
        Available
        {isSearching && <span style={{ fontWeight: 'normal' }}> …</span>}
        {!isSearching && available.length > 0 && (
          <span>{available.length}</span>
        )}
      </div>

      {selectedSources.length === 0 ? (
        <div className="source-filter__warning" role="alert">
          ⚠ No sources selected — search results are empty.
        </div>
      ) : sorted.length === 0 ? (
        <div className="empty-state">No packages found</div>
      ) : (
        <div className="pkg-section__list" role="listbox" aria-label="Available packages list">
          {sorted.map((pkg) => (
            <PackageRow
              key={pkg.id}
              pkg={pkg}
              kind="available"
              selected={state.detail.selectedPackageId === pkg.id}
              onClick={() => dispatch({ type: 'SELECT_PACKAGE', packageId: pkg.id })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
