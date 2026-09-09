/**
 * Merging the feed's per-version flags across a package family (#92).
 *
 * The Updates tab's family selector picks one version and the batch installs it
 * for every member, so a version flagged for any member is a version the click
 * would apply anyway — but saying only "⚠" would be misleading, because partial
 * flagging is the common case rather than the exception. Measured across
 * `System.Text.Json` and `System.Text.Encodings.Web`, of the 44 versions the
 * two share, 5 are flagged for both and 5 for exactly one (`6.0.0`, `7.0.0` and
 * `8.0.0` among them). So the mark names the members it came from.
 */

export interface VersionFlag {
  vulnerable?: boolean;
  deprecation?: string;
  /** Members the flag came from, in the order the family lists them. Absent for a single package. */
  packages?: string[];
}

export function mergeFamilyVersionFlags(
  members: ReadonlyArray<{ packageId: string; flags: Record<string, VersionFlag> | undefined }>,
): Record<string, VersionFlag> {
  const merged: Record<string, VersionFlag> = {};

  for (const { packageId, flags } of members) {
    for (const [version, flag] of Object.entries(flags ?? {})) {
      if (!flag.vulnerable && !flag.deprecation) continue;

      const entry = merged[version] ?? { packages: [] };
      if (flag.vulnerable) entry.vulnerable = true;
      // One sentence is all the tooltip has room for; the package list that
      // follows it is what says how far the deprecation actually reaches.
      if (flag.deprecation && !entry.deprecation) entry.deprecation = flag.deprecation;
      if (!entry.packages?.includes(packageId)) entry.packages?.push(packageId);
      merged[version] = entry;
    }
  }

  return merged;
}
