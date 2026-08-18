import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { PackageRow } from './PackageRow';
import { matchesQuery, sortByRelevance } from '../utils/search';
import type { InstalledPackage } from '../../types';

function PackagesSkeleton() {
  return (
    <div className="pkg-skeleton" aria-label="Loading packages" aria-busy="true">
      {[40, 55, 35, 60, 45].map((w, i) => (
        <div key={i} className="pkg-skeleton__row">
          <div className="skeleton pkg-skeleton__name" style={{ width: `${w}%` }} />
          <div className="skeleton pkg-skeleton__ver" style={{ width: '20%' }} />
        </div>
      ))}
    </div>
  );
}

/** Group packages by id, collecting all project/version entries */
function groupById(packages: InstalledPackage[]): Map<string, InstalledPackage[]> {
  const map = new Map<string, InstalledPackage[]>();
  for (const pkg of packages) {
    const key = pkg.id.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(pkg);
  }
  return map;
}

export function InstalledList() {
  const { state, dispatch } = useNugetManager();
  const { installed, implicit, searchQuery, isLoadingPackages } = state.packages;

  // implicit versions by parent package id
  const implicitByParent: Record<string, string[]> = {};
  for (const pkg of implicit) {
    if (pkg.dependsOn) {
      if (!implicitByParent[pkg.dependsOn]) implicitByParent[pkg.dependsOn] = [];
      implicitByParent[pkg.dependsOn].push(pkg.resolvedVersion);
    }
  }

  const filtered = installed.filter((pkg) => matchesQuery(pkg.id, searchQuery));

  // Deduplicate by id — use the first entry as the representative row
  const grouped = groupById(filtered);
  const uniquePackages = [...grouped.values()].map((entries) => entries[0]);

  const displayed = searchQuery.length >= 2
    ? sortByRelevance(uniquePackages, searchQuery)
    : uniquePackages;

  const totalUnique = groupById(installed).size;

  return (
    <section className="pkg-section" aria-label="Installed packages">
      <div className="pkg-section__header">
        Installed{' '}
        {!isLoadingPackages && (
          <span>
            {displayed.length}
            {displayed.length !== totalUnique && `/${totalUnique}`}
          </span>
        )}
      </div>

      {isLoadingPackages ? (
        <PackagesSkeleton />
      ) : displayed.length === 0 ? (
        // Show nothing when 0 packages and not loading — no misleading "No packages"
        null
      ) : (
        <div className="pkg-section__list" role="listbox" aria-label="Installed packages list">
          {displayed.map((pkg) => {
            const allEntries = grouped.get(pkg.id.toLowerCase())!;
            return (
              <PackageRow
                key={pkg.id}
                pkg={pkg}
                kind="installed"
                selected={state.detail.selectedPackageId === pkg.id}
                implicitVersions={implicitByParent[pkg.id]}
                allProjectEntries={allEntries}
                onClick={() => dispatch({ type: 'SELECT_PACKAGE', packageId: pkg.id })}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
