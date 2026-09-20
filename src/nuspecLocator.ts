import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * The version directory's own entries for `packageId`@`version`, and which of
 * `packageFolders` held it — or undefined if not found in any of them (a
 * pruned cache, or a package resolved only from a fallback folder that has
 * since gone). Shared by `findNuspecFile` and `findChangelogFile` so the two
 * walk the same folders the same way from one place: naming the `.nuspec` and
 * naming a changelog are both "does this directory listing contain a file
 * matching X", and duplicating the walk itself would let the two silently
 * diverge on how a version folder is matched (#125).
 *
 * Layout is `<folder>/<id lowercased>/<version>/...`, but the version folder
 * is matched case-insensitively, defensively — NuGet writes it lowercased in
 * practice, but nothing guarantees the `version` string passed in here
 * matches that casing exactly.
 */
async function versionDirEntries(
  packageFolders: string[],
  packageId: string,
  version: string,
): Promise<{ versionDir: string; entries: string[] } | undefined> {
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
    return { versionDir, entries };
  }
  return undefined;
}

/**
 * Path to the `.nuspec` NuGet extracted for `packageId`@`version`, or
 * undefined if not found — the caller should fall back to search-derived
 * metadata then, per #86.
 *
 * Filename casing varies between packages, so this globs for a `*.nuspec`
 * file inside the version folder rather than composing the exact name.
 */
export async function findNuspecFile(
  packageFolders: string[],
  packageId: string,
  version: string,
): Promise<string | undefined> {
  const found = await versionDirEntries(packageFolders, packageId, version);
  if (!found) return undefined;
  const nuspecName = found.entries.find((e) => e.toLowerCase().endsWith('.nuspec'));
  return nuspecName ? path.join(found.versionDir, nuspecName) : undefined;
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
 * Conventional changelog file names this extension recognises, matched
 * case-insensitively at the package root only — no recursion, and no attempt
 * at anything a publisher might have named differently (#125).
 */
const CHANGELOG_NAMES = new Set(['changelog.md', 'changelog.txt', 'releasenotes.md', 'release-notes.md']);

/**
 * A changelog the installed version shipped beside its `.nuspec`, or
 * undefined when none of the conventional names is there (#125).
 *
 * Describes the *installed* version's own history up to itself — never the
 * version an update would move to, which this extracted folder cannot
 * contain and nothing here pretends to fetch for.
 */
export async function findChangelogFile(
  packageFolders: string[],
  packageId: string,
  version: string,
): Promise<string | undefined> {
  const found = await versionDirEntries(packageFolders, packageId, version);
  if (!found) return undefined;
  const changelogName = found.entries.find((e) => CHANGELOG_NAMES.has(e.toLowerCase()));
  return changelogName ? path.join(found.versionDir, changelogName) : undefined;
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
