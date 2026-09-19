/**
 * The silent case #107 opens with: `dotnet restore` accepts a version whose
 * feed-declared frameworks don't actually cover the project, and nothing
 * downstream of restore says so until the compiler does, as a `CS0234` /
 * `CS0246` that never names the package.
 *
 * The rule needs no network call and no prediction — `project.assets.json`
 * already states both halves after every restore: `libraries[id/version].files`
 * is what the package ships, `targets[tfm][id/version].compile` is what NuGet
 * actually selected for this project's framework. A package whose files
 * include a `lib/` or `ref/` folder but whose `compile` came back empty was
 * restored with no assembly for this target framework — restore matched it on
 * some other asset (commonly a `build/…targets` file) and NuGet's own
 * compatibility check asks for any matching group, not specifically `compile`.
 *
 * `files` is what keeps this honest: a metapackage or an analyzer-only package
 * has no `lib/`/`ref/` folder at all, and an empty `compile` there is exactly
 * what restore is supposed to produce.
 */

import { assetsLibraryId, assetsLibraryVersion } from './packageGraph';
import { sortTargetFrameworksDesc } from './targetFrameworks';

export interface MissingCompileAsset {
  id: string;
  version: string;
  /** The RID-qualified suffix is stripped — this names the project's own TFM. */
  framework: string;
  /** `lib/<tfm>` / `ref/<tfm>` folders the package does ship, newest first — empty is never reported (see module doc). */
  shipsOnly: string[];
}

interface AssetsTargetLib {
  type?: string;
  compile?: Record<string, unknown>;
}

interface AssetsJson {
  targets?: Record<string, Record<string, AssetsTargetLib>>;
  libraries?: Record<string, { files?: string[] }>;
}

/** `net8.0/win-x64` → `net8.0`. A RID-qualified target restates the same
 * library entries as the plain one; skipping it avoids reporting the same
 * mismatch twice. */
function baseFramework(targetKey: string): string {
  const slash = targetKey.indexOf('/');
  return slash >= 0 ? targetKey.slice(0, slash) : targetKey;
}

function hasCompileAsset(lib: AssetsTargetLib): boolean {
  return !!lib.compile && Object.keys(lib.compile).length > 0;
}

/**
 * Every `lib/<tfm>` or `ref/<tfm>` folder a library's `files` names, deduped,
 * newest TFM first. Deliberately requires the TFM subfolder — a package
 * shipping a bare `lib/Foo.dll` at the root (the NuGet v1 layout, long
 * obsolete) is out of scope, the same restriction
 * `packageDependencyTree.ts`'s `supportedFrameworksFromFiles` already applies
 * for the same reason: with no named folder, there is no framework to state
 * the mismatch is *for*.
 */
function shippedFolders(files: string[] | undefined): string[] {
  const seen = new Map<string, string>(); // tfm → "lib/<tfm>" | "ref/<tfm>", lib preferred when both exist
  for (const f of files ?? []) {
    const m = /^(lib|ref)\/([^/]+)\//.exec(f);
    if (!m) continue;
    const [, kind, tfm] = m;
    if (kind === 'lib' || !seen.has(tfm)) seen.set(tfm, `${kind}/${tfm}`);
  }
  return sortTargetFrameworksDesc([...seen.keys()]).map((tfm) => seen.get(tfm)!);
}

function findLibraryEntry(
  libraries: Record<string, { files?: string[] }>,
  libKey: string,
): { files?: string[] } | undefined {
  if (libraries[libKey]) return libraries[libKey];
  const wantLower = libKey.toLowerCase();
  const found = Object.keys(libraries).find((k) => k.toLowerCase() === wantLower);
  return found ? libraries[found] : undefined;
}

/**
 * Every (package, framework) pair in this restore whose resolved version was
 * matched on some asset other than `compile` while still shipping `lib/` or
 * `ref/` folders — the case a compile error will surface later, with no
 * mention of which package caused it.
 */
export function findMissingCompileAssets(assetsJson: unknown): MissingCompileAsset[] {
  if (!assetsJson || typeof assetsJson !== 'object') return [];
  const json = assetsJson as AssetsJson;
  const targets = json.targets;
  if (!targets || typeof targets !== 'object') return [];
  const libraries = json.libraries ?? {};

  const results: MissingCompileAsset[] = [];
  for (const [targetKey, libs] of Object.entries(targets)) {
    if (targetKey.includes('/')) continue; // RID-qualified — see baseFramework doc.
    if (!libs || typeof libs !== 'object') continue;
    const framework = baseFramework(targetKey);

    for (const [libKey, lib] of Object.entries(libs)) {
      if (!lib || typeof lib !== 'object') continue;
      if (lib.type && lib.type !== 'package') continue;
      if (hasCompileAsset(lib)) continue;

      const id = assetsLibraryId(libKey);
      const version = assetsLibraryVersion(libKey);
      if (!id || !version) continue;

      const files = findLibraryEntry(libraries, libKey)?.files;
      const shipsOnly = shippedFolders(files);
      if (shipsOnly.length === 0) continue; // no lib/ or ref/ at all — an ordinary metapackage/analyzer/build-only package.

      results.push({ id, version, framework, shipsOnly });
    }
  }
  return results;
}
