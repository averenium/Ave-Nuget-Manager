# Changelog

## Unreleased

### Fixed

- Vulnerabilities didn't recheck reliably after an install/update: the restore-text fallback stayed pinned to the last explicit Restore, an audit-source change didn't trigger a rescan, a row could show a *different* project's finding for the same package id at another version (e.g. seen only transitively through a `<ProjectReference>`), and the fallback path trusted an already-stale `--no-restore` package list instead of re-restoring the solution/folder first (#53)

## 0.4.2

### Changed

- No longer marked **Preview** on the Marketplace — dropped the `preview` flag and the leftover "(preview)" wording in the README's Install / Known limits sections.

## 0.4.1

### Changed

- **Sources**: Edit / Remove / Add-source UI polish — floating popup instead of pushing the list down, icon buttons for Edit/Remove, remove confirmation moved into the popup, right-click **Add as audit source** works from anywhere on the row, and audit sources also get a Remove action (#48)

## 0.4.0

### Added

- **Sources**: add / remove package sources, add a package source as an audit source (#48)
- **Sources**: `packageSourceMapping` pattern editor per source; **∅** mark on Packages for an installed id with no matching source under an active mapping (#40)
- **Folder scope**: manage a folder of loose `.csproj`/`.fsproj` with no `.sln` as one group (#39)
- Groups: entangled-cluster updates — packages that only fail one-at-a-time because a sibling `ProjectReference` needs them bumped together now land in one `--no-restore` pass + a single restore (#38)
- Loading skeleton on **Groups** (was plain text), matching **Packages** (#43)

### Changed

- High Contrast / Windows forced-colors support: buttons, tabs, and status marks keep a visible border/outline instead of relying on color alone (#44)
- Trace sanitizer: redacts proxy `.user`/`no_proxy` values and the containing-directory form of a project path (`cwd`), and follows `<ProjectReference>` to alias sibling projects within the workspace root (#38)

## 0.3.0

### Added

- **Sources** tab: full editor — toggle sources, credentials / API key, HTTP flags (#36)
- Roslyn SDK cap: **Groups** will not target `Microsoft.CodeAnalysis.*` above the compiler bundled with the active SDK (#13)
- Retry policy for transient `dotnet add` failures (NU1301, HTTP 429/502/503, network, file lock) (#9)
- Settings button on the panel title bar (#22)

### Changed

- Vulnerability scan skipped (with a hint) when no configured source has working `VulnerabilityInfo`, instead of a silent empty scan (#7)

### Fixed

- Legacy (non-SDK-style) `.csproj` package updates (#12)

## 0.2.0

Marketplace **pre-release** since 0.1.0 (issues #1–#29 that landed).

### Added

- **Stop** on Groups batch updates (#1)
- Restore vs Force refresh, plus a 7px progress strip (#2)
- Lazy panel: no `onStartupFinished`; open in editor / new window; drag the view (#3)
- One enrich retry after a failed or empty search wave (#4)
- Switch `.sln` / `.csproj` from the tab bar (#6)
- Vulnerability marks follow the restore graph; optional user script (#7)
- Workspace **Block updates** / **Unblock updates** (`blockedPackages`) (#8)
- Agent skill: copy **Dependency breaking-changes review** for Cursor / Claude / Kiro (#14)
- **Trace**: Start / Stop & save a sanitized zip from Log (and Palette) (#23)
- **Agents** tab (after Log): install or update that skill; tab stays visible with no agent CLI (#29)

### Changed

- Pre-release off by default (#5)
- Shared `dotnetConcurrency` cap for list, search, enrich, add, remove, restore; longer timeout on add/remove/restore (#10)

### Fixed

- Skip `dotnet add` when the project is already on the target version (#11)

## 0.1.0

First Marketplace **pre-release**.

- Packages, Groups, Sources, and Log panel
- Install / update / remove via `dotnet add` / `dotnet remove`
- Restore-fail rollback (`onFailedUpdate`)
- Family and All batch updates
- Vulnerability marks (`dotnet list --vulnerable`)
- Current restore-graph dependencies in package details
