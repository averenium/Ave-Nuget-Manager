# NuGet: transitives, cache, `.deps.json`

## Direct vs resolved

`Directory.Packages.props` and `PackageReference` in `*.csproj` are **direct** pins. The graph NuGet actually resolved — including transitives — is **`.deps.json`** after a build:

`bin/<configuration>/<tfm>/<AssemblyName>.deps.json`

## Old vs new transitives (Rule 3)

The manifest diff usually does not list transitives. `bin/` is almost never in git, so the **old** transitive version is often unknown — say so; still scan recent releases of those ids (Rule 2).

After the bump, get the **current** tree (flag restore/build to the user first):

1. Prefer a lighter path when a full build is not already required: `dotnet restore` then `dotnet list <path> package --include-transitive`, and `dotnet nuget why <path> <id>` to see which direct pulls a transitive. That is enough to name the handful of transitives under the majorly-bumped direct package.
2. If a fresh `.deps.json` already exists (mtime newer than the manifest), read it instead — see below. Do not trust a stale or failed-build file.
3. Under the majorly-bumped **direct** package, pick the handful of transitives the app code is exposed to (DB driver, HTTP, serialization). Read **recent** tags of those ids (Rule 2).

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

## Rule 4 — diamonds (gated)

Only after a **major** direct bump **and** Rule 3, or if the user asks about conflicts. Not for routine patch/minor.

`dotnet list --include-transitive` shows the unified version. Rule 4 needs **requested ranges per consumer**, which live in `.deps.json` after `dotnet build` or `dotnet publish`:

1. Confirm with the user before a large/slow full-solution build. Prefer the project(s) that reference the bumped id.
2. Read **current** `.deps.json` only if it is newer than the manifest you are reviewing. A failed or incremental build can leave a stale file — rebuild that project if `mtime` is older than `Directory.Packages.props` / the `.csproj`.
3. `libraries` — exact resolved id/version. `targets` → each library’s `dependencies` — the version range that consumer asked for.
4. If two consumers requested different majors for the same id (e.g. Npgsql 9 vs 10) and NuGet unified to one version, flag a **potential runtime incompatibility**, not a confirmed bug and not a compile error. The older consumer was not necessarily tested against the unified version. Recommend a smoke test on that consumer’s code path.

## Commands (copy-paste)

```bash
dotnet restore
dotnet build <path>
dotnet list <path> package --include-transitive
dotnet nuget why <path> <package-id>
```

`<path>` is a `.sln` / `.slnx` / `.csproj` / `.fsproj`.
