/**
 * Which restored version the details panel describes, and what else is in play
 * (#90). The panel is keyed on a package id alone, but a solution resolves a
 * package per project, and those versions can differ — `Newtonsoft.Json` in
 * this repository's own `demo/` restores as 12.0.3 in three projects and 13.0.1
 * in the test project. Picking whichever entry the CLI happened to list first
 * meant the description, licence and dependency tree silently belonged to one
 * of them with nothing on screen saying which.
 */

import { compareSemVer } from './semver';

/** Only the field this decision needs, so both InstalledPackage and ImplicitPackage fit. */
export interface RestoredEntry {
  resolvedVersion: string;
}

export interface ResolvedVersionSpread {
  /** The version the panel's metadata describes. */
  primary: string;
  /** Every other resolved version in the solution, newest first. */
  others: Array<{ version: string; projectCount: number }>;
}

function highest(entries: readonly RestoredEntry[]): string | undefined {
  return [...entries]
    .sort((a, b) => compareSemVer(b.resolvedVersion, a.resolvedVersion))[0]?.resolvedVersion;
}

/**
 * A direct reference wins over a transitive one — that is the version the
 * project asked for — and among equals the highest wins, which is both
 * deterministic and where a consolidation would land. `others` counts the
 * projects still on something else, across both kinds, so the panel can say
 * what it is not describing.
 */
export function resolveVersionSpread(
  direct: readonly RestoredEntry[],
  transitive: readonly RestoredEntry[],
): ResolvedVersionSpread | undefined {
  const primary = highest(direct.length > 0 ? direct : transitive);
  if (primary === undefined) return undefined;

  const counts = new Map<string, number>();
  for (const entry of [...direct, ...transitive]) {
    if (entry.resolvedVersion === primary) continue;
    counts.set(entry.resolvedVersion, (counts.get(entry.resolvedVersion) ?? 0) + 1);
  }

  const others = [...counts.entries()]
    .map(([version, projectCount]) => ({ version, projectCount }))
    .sort((a, b) => compareSemVer(b.version, a.version));

  return { primary, others };
}
