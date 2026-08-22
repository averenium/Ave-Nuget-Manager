import React, { useCallback, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { PackageRow } from './PackageRow';
import { BlockedPackageMenu } from './BlockedPackageMenu';
import { matchesQuery, sortByRelevance } from '../utils/search';
import type { InstalledPackage } from '../../types';
import { findingsAffectingPackage, vulnerabilityAffectRank } from '../../vulnerabilities';
import { compareSemVer } from '../../semver';
import { isPackageBlocked } from '../../blockedPackages';

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

function packageHasUpdate(pkg: InstalledPackage): boolean {
  if (!pkg.latestVersion || !pkg.resolvedVersion) return false;
  return compareSemVer(pkg.latestVersion, pkg.resolvedVersion) > 0;
}

function withUnionedDeps(entries: InstalledPackage[]): InstalledPackage {
  const deps = [...new Set(entries.flatMap((e) => e.dependencies ?? []))];
  return deps.length > 0 ? { ...entries[0], dependencies: deps } : entries[0];
}

export function InstalledList() {
  const { state, dispatch } = useNugetManager();
  const { installed, implicit, searchQuery, isLoadingPackages, vulnerabilities, blockedPackages, vulnHint, vulnHintDismissedFingerprint } = state.packages;
  const [menu, setMenu] = useState<{ packageId: string; blocked: boolean; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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
  const uniquePackages = [...grouped.values()].map(withUnionedDeps);

  const displayed = searchQuery.length >= 2
    ? sortByRelevance(uniquePackages, searchQuery)
    : [...uniquePackages].sort((a, b) => {
      const va = vulnerabilityAffectRank(vulnerabilities, a.id, a.dependencies);
      const vb = vulnerabilityAffectRank(vulnerabilities, b.id, b.dependencies);
      if (va !== vb) return vb - va;
      const ua = packageHasUpdate(a) ? 1 : 0;
      const ub = packageHasUpdate(b) ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return a.id.localeCompare(b.id);
    });

  const totalUnique = groupById(installed).size;
  const vulnPkgCount = uniquePackages.filter((pkg) => {
    const { direct, via } = findingsAffectingPackage(vulnerabilities, pkg.id, pkg.dependencies);
    return direct.length + via.length > 0;
  }).length;

  const showVulnHint = !!vulnHint?.show
    && vulnerabilities.length === 0
    && vulnHint.fingerprint !== vulnHintDismissedFingerprint;

  return (
    <section className="pkg-section" aria-label="Installed packages">
      <div className="pkg-section__header">
        Installed{' '}
        {!isLoadingPackages && (
          <span>
            {displayed.length}
            {displayed.length !== totalUnique && `/${totalUnique}`}
            {vulnPkgCount > 0 ? ` · ${vulnPkgCount} vuln` : ''}
          </span>
        )}
      </div>

      {showVulnHint && (
        <div className="vuln-hint" role="status">
          <span>CLI ⚠ skipped — add a working {'<auditSources>'} entry.</span>
          <button
            type="button"
            className="vuln-hint__dismiss"
            onClick={() => dispatch({ type: 'DISMISS_VULN_HINT' })}
            aria-label="Dismiss vulnerability scan hint"
          >
            ✕
          </button>
        </div>
      )}

      {isLoadingPackages ? (
        <PackagesSkeleton />
      ) : displayed.length === 0 ? (
        // Show nothing when 0 packages and not loading — no misleading "No packages"
        null
      ) : (
        <div className="pkg-section__list" role="listbox" aria-label="Installed packages list">
          {displayed.map((pkg) => {
            const allEntries = grouped.get(pkg.id.toLowerCase())!;
            const blocked = isPackageBlocked(pkg.id, blockedPackages);
            return (
              <PackageRow
                key={pkg.id}
                pkg={pkg}
                kind="installed"
                selected={state.detail.selectedPackageId === pkg.id}
                implicitVersions={implicitByParent[pkg.id]}
                allProjectEntries={allEntries}
                findings={vulnerabilities}
                blocked={blocked}
                onClick={() => dispatch({ type: 'SELECT_PACKAGE', packageId: pkg.id })}
                onContextMenu={(e) => setMenu({ packageId: pkg.id, blocked, x: e.clientX, y: e.clientY })}
              />
            );
          })}
        </div>
      )}
      {menu ? (
        <BlockedPackageMenu
          packageId={menu.packageId}
          blocked={menu.blocked}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        />
      ) : null}
    </section>
  );
}
