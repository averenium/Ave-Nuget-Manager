# NuGet: transitives, cache, graph

## Direct vs resolved

`Directory.Packages.props` and `PackageReference` in `*.csproj` are **direct** pins. After restore, **resolved** versions (including transitives) are in `obj/project.assets.json` and `dotnet list --include-transitive`.

Requested ranges per consumer (diamonds) are in the same `project.assets.json`: `targets` → each library’s `dependencies` map (`id` → version range). `.deps.json` after a build is an optional extra copy, not a prerequisite.

`bin/<configuration>/<tfm>/<AssemblyName>.deps.json` — use only if it already exists and is newer than the manifest. Do **not** start `dotnet build` to obtain it.

## Restore graph (always)

Release notes do not show what NuGet actually resolved. **Always** restore and inspect the graph in the same review as the notes, including patch/minor. Do not wait for a major bump or for the user to ask.

If `packages.lock.json` is in the diff, `git diff` that file first (old and new transitives without restore). Still restore if the lockfile is absent, stale, or not committed.

Then:

1. `dotnet restore` then `dotnet list <path> package --include-transitive`.
2. `dotnet nuget why <path> <id>` for shared ids and for any transitive whose major moved.
3. Read `obj/project.assets.json` next to each relevant `.csproj` (after restore it must exist).
   - `libraries` / list output — exact resolved id/version.
   - `targets` → `dependencies` — the version **range** that consumer asked for.
4. In the report: requested (csproj / `Directory.Packages.props`) vs resolved, new or majorly-moved transitives, the same id pulled by several directs.

A failed restore (no assets file) is **Unverified** for the graph, not Compatible.

`dotnet list --include-transitive` shows the **unified** version only. If two consumers requested different majors for the same id (e.g. Npgsql 9 vs 10) and NuGet unified to one version, flag a **potential runtime incompatibility**, not a confirmed bug and not a compile error. Recommend a smoke test on the older consumer’s code path.

## Old vs new transitives (Rule 3)

The manifest diff usually does not list transitives. `bin/` is almost never in git, so the **old** transitive version is often unknown — say so; still scan recent releases of those ids (Rule 2).

The **current** tree comes from the restore step above. Under a majorly-bumped **direct** package (or a transitive major the graph just revealed), pick the handful of transitives the app code is exposed to (DB driver, HTTP, serialization). Read **recent** tags of those ids (Rule 2).

## Authoritative notes

- GitHub **release/tag** URL for that version, not the repo Releases index (indexes truncate “Breaking Changes”).
- If you use the Releases list or a milestone changelog to cover a range in one fetch, confirm the view starts at or before the **old** version. Default pagination often shows only recent tags.
- Repo `CHANGELOG.md` / `SDK.CHANGELOG.md` if tags are sparse.
- Framework notes (`dotnet/core` release-notes, ASP.NET breaking-changes docs).
- Umbrella changelogs (Aspire wiki / one page covering many package ids) count for every id they list.
- Changelog too large to fetch: say so; do not skip silently. Fall back to a migration guide, a downstream package’s notes that had to patch around the same dependency, or inspect direct API usage in this repo. Then mark **Unverified** if you still cannot read the source.

## Private / cached packages

Public GitHub may not exist. After restore, inspect:

`~/.nuget/packages/<package-id>/<version>/`

Look for `CHANGELOG.md`, `RELEASENOTES.md`, or similar at the package root, `content/`, `contentFiles/`, or `lib/`. Read `.nuspec` `<releaseNotes>` (and `PackageReleaseNotes` if present in the nupkg). Do not skip an id only because it has no public repo. If nothing is there, mark **Unverified** and state that this cache path was inspected.

## Commands (copy-paste)

```bash
dotnet restore
dotnet list <path> package --include-transitive
dotnet nuget why <path> <package-id>
```

`<path>` is a `.sln` / `.slnx` / `.csproj` / `.fsproj`.

Do not add `dotnet build` to this checklist. Graph data is in `obj/project.assets.json` after restore.
