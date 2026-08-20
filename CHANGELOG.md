# Changelog

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
