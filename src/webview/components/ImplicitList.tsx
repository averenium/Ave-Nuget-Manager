import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { PackageRow } from './PackageRow';
import { matchesQuery, sortByRelevance } from '../utils/search';
import type { ImplicitPackage } from '../../types';

function groupById(packages: ImplicitPackage[]): Map<string, ImplicitPackage[]> {
  const map = new Map<string, ImplicitPackage[]>();
  for (const pkg of packages) {
    const key = pkg.id.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(pkg);
  }
  return map;
}

export function ImplicitList() {
  const { state, dispatch } = useNugetManager();
  const { implicit, installed, searchQuery, isLoadingPackages } = state.packages;

  // Exclude packages already shown in the Installed list
  const installedIds = new Set(installed.map((p) => p.id.toLowerCase()));
  const implicitOnly = implicit.filter((p) => !installedIds.has(p.id.toLowerCase()));

  const filtered = implicitOnly.filter((pkg) => matchesQuery(pkg.id, searchQuery));

  // Deduplicate by id — representative = first entry
  const grouped = groupById(filtered);
  const uniquePackages = [...grouped.values()].map((entries) => entries[0]);

  const displayed = searchQuery.length >= 2
    ? sortByRelevance(uniquePackages, searchQuery)
    : uniquePackages;

  const totalUnique = groupById(implicitOnly).size;

  return (
    <section className="pkg-section" aria-label="Implicit packages">
      <div className="pkg-section__header">
        Implicit{' '}
        {!isLoadingPackages && (
          <span>
            {displayed.length}
            {displayed.length !== totalUnique && `/${totalUnique}`}
          </span>
        )}
      </div>

      {isLoadingPackages ? null : displayed.length === 0 ? null : (
        <div className="pkg-section__list" role="listbox" aria-label="Implicit packages list">
          {displayed.map((pkg) => {
            const allEntries = grouped.get(pkg.id.toLowerCase())!;
            return (
              <PackageRow
                key={pkg.id}
                pkg={pkg}
                kind="implicit"
                selected={state.detail.selectedPackageId === pkg.id}
                allProjectEntries={allEntries as any}
                onClick={() => dispatch({ type: 'SELECT_PACKAGE', packageId: pkg.id })}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
