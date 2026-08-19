import React from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { listedDependencyTree, type ListedDepNode } from '../../packageGraph';
import { packageIdsEqual } from '../../pathCompare';
import type { ImplicitPackage, InstalledPackage } from '../../types';

function depsByIdFromPackages(
  packages: Array<{ id: string; dependencies?: string[] }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pkg of packages) {
    const key = pkg.id.toLowerCase();
    const merged = [...new Set([...(map.get(key) ?? []), ...(pkg.dependencies ?? [])])];
    if (merged.length > 0) map.set(key, merged);
  }
  return map;
}

function uniqueJoined(values: Array<string | undefined>): string {
  return [...new Set(values.filter((v): v is string => !!v))].join(' / ');
}

function packageMeta(
  packageId: string,
  packages: Array<{ id: string; resolvedVersion: string; framework?: string }>,
): { version: string; framework: string } {
  const rows = packages.filter((p) => packageIdsEqual(p.id, packageId));
  return {
    version: uniqueJoined(rows.map((p) => p.resolvedVersion)),
    framework: uniqueJoined(rows.map((p) => p.framework)),
  };
}

interface Props {
  packageId: string;
}

export function CurrentDependenciesSection({ packageId }: Props) {
  const { state, dispatch } = useNugetManager();
  const { installed, implicit } = state.packages;
  const listed = [...installed, ...implicit];
  if (!listed.some((p) => packageIdsEqual(p.id, packageId))) return null;

  const tree = listedDependencyTree(packageId, depsByIdFromPackages(listed));
  if (tree.length === 0) return null;

  const installedIds = new Set(installed.map((p) => p.id.toLowerCase()));

  return (
    <div className="detail-section">
      <div
        className="detail-section__title"
        title="Restore graph for the currently installed version"
      >
        Current Dependencies
      </div>
      <DepList
        nodes={tree}
        installedIds={installedIds}
        installed={installed}
        implicit={implicit}
        onSelect={(id) => dispatch({ type: 'SELECT_PACKAGE', packageId: id })}
      />
    </div>
  );
}

function DepList({
  nodes,
  installedIds,
  installed,
  implicit,
  onSelect,
}: {
  nodes: ListedDepNode[];
  installedIds: Set<string>;
  installed: InstalledPackage[];
  implicit: ImplicitPackage[];
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="current-deps">
      {nodes.map((node) => {
        const implicitOnly = !installedIds.has(node.id.toLowerCase());
        const { version, framework } = packageMeta(node.id, [...installed, ...implicit]);
        return (
          <li key={node.id}>
            <div className="current-deps__row">
              <span className="current-deps__id">
                <button
                  type="button"
                  className={`current-deps__name${implicitOnly ? ' current-deps__name--implicit' : ''}`}
                  onClick={() => onSelect(node.id)}
                  title={
                    [node.id, version, framework, implicitOnly ? 'implicit' : '']
                      .filter(Boolean)
                      .join(' · ')
                  }
                >
                  {node.id}
                </button>
                {version ? <span className="current-deps__ver">{version}</span> : null}
              </span>
              {framework ? <span className="current-deps__tfm">{framework}</span> : null}
            </div>
            {node.children.length > 0 ? (
              <DepList
                nodes={node.children}
                installedIds={installedIds}
                installed={installed}
                implicit={implicit}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
