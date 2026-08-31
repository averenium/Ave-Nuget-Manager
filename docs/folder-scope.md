# Folder scope (no `.sln`)

Closes #39: a folder containing several `.csproj`/`.fsproj` files with no `.sln`/`.slnx` tying them together.

`WorkspaceScope` (`src/types.ts`) has a third variant alongside `solution` and `project`:

```ts
{ kind: 'folder'; folderPath: string; projects: ProjectInfo[] }
```

## Discovery

`findDotnetTargetsInFolder(folderPath)` (`src/dotnetWorkspace.ts`) is the
single shared "what's in this folder" primitive — both `CommandRegistrar`
(folder click / "open" command) and `WebviewMessageBroker._detectWorkspaceScope`
(auto-select on the first `WEBVIEW_READY`) call it instead of each hand-rolling
their own scan, so the two can't quietly diverge on how they find projects
(an earlier version had the auto-detect side scan the whole multi-root
workspace instead of just `workspaceFolders[0]` — see the #39 PR review).

Matching is two-tier: it checks the folder's immediate children first (cheap,
and the common one-project-per-folder case); only when that finds nothing
does it fall back to a recursive `vscode.workspace.findFiles` scan (scoped to
that folder via `RelativePattern`, excluding `bin`/`obj`/`node_modules`/`.git`),
so the equally common "one subfolder per project" layout
(`Root/ServiceA/A.csproj`, `Root/ServiceB/B.csproj`, no `.csproj` directly
under `Root`) is picked up without the user having to click into a subfolder
first.

`CommandRegistrar._pickAmongMultiple` offers a **"Manage all N projects in
this folder"** QuickPick entry whenever the matches include more than one
`.csproj`/`.fsproj` and no `.sln` — a single solution always wins outright.
It builds each entry's `ProjectInfo` with `toProjectInfo` from the matches it
already has and passes that list straight into `scopeFromFolder(folderPath,
projects)`, so picking "manage all" does not re-scan the folder a second time.
`_detectWorkspaceScope` does the same for its own auto-selected folder scope.

## Why not a virtual `.sln`?

An earlier design generated a temporary `.sln` on disk so the existing
solution codepath (`dotnet list <sln> package`, `dotnet restore <sln>`) could
be reused untouched. That was rejected: it is a filesystem side effect
(unique naming, keeping it in sync with folder contents, cleanup, conflicts
across windows) and hard to unit-test.

Instead, folder scope reuses the CLI's existing **single-project** operations
— `restoreProject`/`listAllForProject`/`listVulnerable` already accept one
project path — and fans them out over every discovered project with
`runWithConcurrency` (capped by `dotnetConcurrency`, the same setting used for
batch updates), merging the results in TypeScript:

- `WebviewMessageBroker._refreshForFolder` restores every project in parallel
  via `_restoreProjects` (merges N `CliResult`s with `mergeCliResults` in
  `dotnetOutput.ts` — any one failure fails the whole restore) and lists every
  project via the existing `_listProjectsThenApply` (already generic over a
  project-path list).
- `DotnetVulnerableProvider.scan` (`src/vulnerabilityProvider.ts`) fans out
  `listVulnerable` per project for a folder scope and merges findings, instead
  of calling `dotnet list --vulnerable` on a single solution/project path.

## UI

Solution and folder scopes are treated as equivalent "multi-project" scopes
in the webview (`PackageDetailPanel.tsx`'s `isMultiProject`, `App.tsx`'s scope
label/icon, `SourcesTab.tsx`'s `scopeTitle`) — both show the per-project
install/remove picker and the Projects section, keyed off `scope.projects`
rather than a real solution file.

## Known limitations (MVP)

- Restoring a folder is N `dotnet restore` processes instead of one — slower
  than a real solution for very large folders, acceptable for the typical
  handful-to-dozens-of-projects case this issue targets.
- A subfolder that itself belongs to another `.sln` further up the tree is
  not special-cased — every `.csproj`/`.fsproj` under the chosen root is
  included.
- Cross-project `ProjectReference` dependencies are not built into a separate
  graph; `dotnet list <project> package --include-transitive` already
  accounts for them via each project's own restore assets.
