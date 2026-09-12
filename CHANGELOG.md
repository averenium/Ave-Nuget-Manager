# Changelog

## 0.8.0

### Added
- Implemented multi TFM projects. Update no longer collapses a package pinned per target framework onto one version: each framework gets its own row, target, write and install (#82)

### Fixed

- Hovering a row no longer washes out its selected colours, and High Contrast themes no longer show a hardcoded dark fill where they define none (#108)

## 0.7.5

### Added

- **Package details**: a transitive package lists the projects that pull it in, each with a one-click direct reference at the restored version (#90)
- **Packages** and **Log**: Ctrl+F (Cmd+F) focuses that tab's search box and selects what is already in it (#93)
- Install and remove show progress beside the **Projects** heading, held through the refresh that follows (#104)

### Fixed

- Every version picker shows a dropdown arrow, and inputs and dropdowns answer hover, focus and being open the same way (#99)
- **Updates**: the family target selector marks vulnerable and deprecated versions, naming the members each mark came from (#92)
- Package search no longer launches `dotnet` for a config file that cannot answer — no sources, or folder sources without the package (#91)
- **Install** has its own icon instead of the downgrade arrow, and the action buttons answer the pointer (#88)
- The development-only hot-reload watcher no longer runs in an installed extension, where it could fail activation on Linux (#95)

## 0.7.0

### Added

- **Package details**: the **Info** panel is built from the local `.nuspec` and `project.assets.json` instead of a feed search — authors, licence, source and commit links and target frameworks beside the description, and a **Dependencies** list showing each declared range against the version actually resolved (#86)

### Fixed

- A comment mentioning a tag or single-quoted attributes (both valid XML) could hide or duplicate a `nuget.config` entry, or corrupt a non-SDK `.csproj` on save (#85)

## 0.6.1

### Added

- **Agent skill** (Dependency breaking-changes review, bumped to `1.1.0`): a bundled `scripts/review.fsx` run via `dotnet fsi` — `diff`, `graph` and `notes` collect the manifest diff, the restore graph and every changed package's release notes for a pending bump, and write a report skeleton the agent fills in. Needs no GitHub token (#67)
- **Docs**: new [`docs/vulnerability-script.md`](docs/vulnerability-script.md) — the `averenium.nugetManager.vulnerabilityScript` protocol, with JavaScript and Python examples (#69)
- `averenium.nugetManager.vulnerabilityScript` also runs `.fsx` (`dotnet fsi`), `.csx` (`dotnet script`) and managed `.dll` (#69)
- **Docs**: README reworked as a landing page for the VS Code Marketplace and Open VSX — what the extension replaces, a quick start, an install table per editor, and a screenshot slot per feature (#84)
- Marketplace search terms: `description` rewritten and `keywords` expanded from 5 to 23 (#84)


### Fixed

- **Log**: **Copy sanitised** now masks project names too, using the same `pNN.csproj` aliases as a trace zip (#65)
- **Log**: expanded-row and toolbar polish — no duplicate Copy on non-CLI entries, repositioned hover-copy button, and the "N new ↓" pill no longer scrolls away (#66)
- Selecting a not-installed package no longer shows the version picked for a different package (#59)
- The source filter dropdown now closes on an outside click, Escape, blur, or scroll (#70)
- Moving the panel between locations replays the last state from cache instead of forcing a full restore, list and vulnerability scan (#71)
- `dotnet list`/`--vulnerable` timeout now scales with the project count (30s to 120s), with one retry after a timeout (#72)
- The version list is seeded from cached enrich data instead of blanking to "Loading…" on every package selection (#76)
- Hover states add an outline so they stay visible in High Contrast themes (#68)
- **Groups**: the right-hand detail panel no longer blanks (name, version selector, package list) right after a group update succeeds, including when the same family is split across projects pinned to different versions

## 0.5.0

### Added

- A per-project row briefly flashes (green for an upgrade, amber for a downgrade) when its version change actually lands, respecting `prefers-reduced-motion` (#56)
- Package detail panel: generalized the **Vulnerabilities** section into a **Problems** section that also explains a `packageSourceMapping` mismatch (which sources are mapped, why none match) and a blocked-updates state — previously those only showed as a bare row-mark tooltip with no detail (#57)
- **Log tab redesign** (#58, subsumes #50/#51/#52): a `kind` (cli/edit/scan/info/error) badge per row, with `args` rendered for the previously content-free synthetic rows (`edit PackageReference`, `nuget.config …`, `vulnerability scan skipped`); an in-panel search over command/args/output plus an All/Errors/CLI/Edits filter, since VS Code's own Ctrl+F cannot reach a sidebar view; day separators between entries from different days; a failure-aware one-line preview (via `summarizeDotnetFailure`) instead of a truncated stdout/stderr dump, with the full command, ordered stdout/stderr, and a clickable `NU‑code` chip once expanded; **Copy**, **Copy sanitised** (same redaction as a trace zip, for pasting into a public issue), and **Open Output** (the previously unreachable unbounded Output Channel) toolbar actions; `Logger.info`/`Logger.error` now also produce a Log-tab row instead of being Output-Channel-only; and a 500-entry ring buffer (host and webview) so a long session doesn't grow memory unbounded — the Output Channel remains the unbounded sink.

Not folded into this pass: correlating a batch update's ~2N rows under one job/group (#58 finding #5) would need a job id threaded through the whole install pipeline (`INuGetBackend`/`CliBackend`/`cliRunner` signatures) — left for a follow-up given the size of this change already.

### Fixed

- Vulnerabilities didn't recheck reliably after an install/update: the restore-text fallback stayed pinned to the last explicit Restore, an audit-source change didn't trigger a rescan, a row could show a *different* project's finding for the same package id at another version (e.g. seen only transitively through a `<ProjectReference>`), and the fallback path trusted an already-stale `--no-restore` package list instead of re-restoring the solution/folder first (#53)
- Update/Install button icons (Packages detail, per-project rows, Groups) always showed **↑**/**↓** regardless of whether the picked version was actually an upgrade, a downgrade, or unchanged — they're now direction-aware, and the button itself looks inactive (muted, not accent-colored) when the picked version already matches what's installed (#55)
- Remove buttons in Packages (detail panel and per-project rows) used a plain **✕** instead of the trash icon already used in Sources, and rendered with the always-red `.btn--danger` styling — now the shared trash icon, muted at rest and red only on hover, matching Sources (#60)
- The **↑**/**⊘**/**⚠**/**∅** row marks sized and positioned their pill off each glyph's own font-dependent metrics, so they rendered as differently-sized circles with the symbol sitting off-center inside the ring (worst for **⚠**) — replaced the Unicode glyphs with small fixed-coordinate SVG icons, the same approach already used for the Sources trash icon, so centering no longer depends on font/platform (#60)
- **Log**: a new entry always auto-scrolled to the bottom, yanking the view away while reading an earlier one — it now only scrolls if the view was already at the bottom, otherwise a "N new ↓" pill appears (#51)
- **Log**: `toLocaleTimeString()` followed the VS Code UI language rather than being explicit — entry times are now a fixed `HH:mm:ss.SSS`, independent of locale, with the full ISO timestamp in a tooltip (#52)


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
