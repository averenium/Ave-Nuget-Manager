import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Path to the `.nuspec` NuGet extracted for `packageId`@`version` into one
 * of `packageFolders`, or undefined if not found in any of them (a pruned
 * cache, or a package resolved only from a fallback folder that has since
 * gone — the caller should fall back to search-derived metadata then, per #86).
 *
 * Layout is `<folder>/<id lowercased>/<version>/<id>.nuspec`, but filename
 * casing varies between packages, so this globs for a `*.nuspec` file
 * inside the version folder rather than composing the exact name. The
 * version folder itself is matched case-insensitively too, defensively —
 * NuGet writes it lowercased in practice, but nothing guarantees the
 * `resolvedVersion` string passed in here matches that casing exactly.
 */
export async function findNuspecFile(
  packageFolders: string[],
  packageId: string,
  version: string,
): Promise<string | undefined> {
  const idLower = packageId.toLowerCase();
  const versionLower = version.toLowerCase();

  for (const folder of packageFolders) {
    const idDir = path.join(folder, idLower);
    let versionDirs: string[];
    try {
      versionDirs = await fs.readdir(idDir);
    } catch {
      continue;
    }
    const versionDirName = versionDirs.find((d) => d.toLowerCase() === versionLower);
    if (!versionDirName) continue;

    const versionDir = path.join(idDir, versionDirName);
    let entries: string[];
    try {
      entries = await fs.readdir(versionDir);
    } catch {
      continue;
    }
    const nuspecName = entries.find((e) => e.toLowerCase().endsWith('.nuspec'));
    if (nuspecName) return path.join(versionDir, nuspecName);
  }
  return undefined;
}

/**
 * The file a `<license type="file">` names, inside the extracted package (#89).
 *
 * The installed version is the one side of a licence comparison that is on disk
 * by definition, so the file it calls its licence can actually be opened — which
 * is the difference between telling someone their licence may have changed and
 * letting them read what it changed from. The nuspec states the path relative to
 * the package root, which is the nuspec's own directory, and it may name a
 * subdirectory.
 *
 * Undefined when the file is not there: the path is stated by the package and
 * nothing guarantees the file was shipped.
 */
export async function findLicenseFile(
  nuspecPath: string,
  relativePath: string,
): Promise<string | undefined> {
  const root = path.dirname(nuspecPath);
  const resolved = path.resolve(root, relativePath);
  // A nuspec is package-supplied data, so a path that climbs out of the package
  // is refused rather than followed.
  if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) return undefined;
  try {
    const stat = await fs.stat(resolved);
    return stat.isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runtime identifiers a package ships native assets for — the directory
 * names directly under the extracted package folder's `runtimes/` (a
 * sibling of the `.nuspec`), e.g. `win-x64`, `linux-x64`. No parsing beyond
 * listing directory names; empty when the package has no RID-specific
 * assets or the folder is missing.
 */
export async function listRuntimeIdentifiers(nuspecPath: string): Promise<string[]> {
  const runtimesDir = path.join(path.dirname(nuspecPath), 'runtimes');
  try {
    const entries = await fs.readdir(runtimesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
