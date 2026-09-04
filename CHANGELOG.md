# Changelog

## Unreleased

### Added

- **Docs**: new user-facing [`docs/vulnerability-script.md`](docs/vulnerability-script.md) — the `averenium.nugetManager.vulnerabilityScript` protocol (stdin/stdout shape, accepted finding fields and aliases, the 30s timeout), a JavaScript example, and a new Python example for the `python <file>` runtime that previously had none documented. Linked from the setting's description and the README settings table (#69)
- `averenium.nugetManager.vulnerabilityScript` now also runs `.fsx` (`dotnet fsi`), `.csx` (`dotnet script`), and `.dll` — a `.dll`'s PE header is checked for a CLR Runtime Header first, so a managed .NET assembly (a published tool, or one built with `dotnet publish`) runs as `dotnet <file>` and a native `.dll` still falls back to running the file itself unchanged

### Fixed

- **Log**: **Copy sanitised** didn't mask project names — only the workspace root, home directory, and hostname were redacted, so a path like `<workspace>/AVE.ElectricityBot.Data/AVE.ElectricityBot.Data.csproj` kept the real project name. It now builds the same `pNN.csproj` aliases as a trace zip, from the current scope's project files (#65)
- **Log**: expanded-row and toolbar polish — removed a redundant "command" block and duplicate Copy button on non-CLI entries, repositioned the per-block hover-copy button (visible, no scroll flicker), and pinned the "N new ↓" pill so it no longer scrolls away with the list (#66)
- Selecting a not-installed package after picking a specific version for a different package kept showing that leftover version instead of the newly selected package's own latest — `selectedVersion` is now reset on every package selection change (#59)
- The source filter dropdown (Packages toolbar) only ever closed via its own toggle button — clicking a package row, or anywhere else on the page, left it open on top of whatever was underneath it. It now closes on an outside click, Escape, blur, or scroll, the same pattern already used by the source-URL context menu (#70)
- Moving the NuGet panel (panel ↔ sidebar ↔ secondary sidebar ↔ new window ↔ "Open in New Window") always tears down and recreates the view, which forced a full `dotnet restore` + `dotnet list` + enrich + vulnerability scan every time regardless of whether the scope actually changed. A re-init for the same scope now replays the last known state (package list, per-package version/source info, vulnerability findings) straight from cache instead of touching the CLI/network at all (#71)
- `dotnet list`/`--vulnerable` (repo-size-bound) shared the same fixed 30s timeout as single-package feed calls, and could legitimately time out on a large solution (`--include-transitive` on a big `.slnx`). Its timeout now scales with the project count (30s for a single project, up to a 120s cap), and one automatic retry follows a timeout specifically — not a plain non-zero exit — since a large list being slow isn't the same as a flaky network failure (#72)
- Selecting a package in the Packages tab always blanked the version list and showed "Loading…" for a moment, even when the version list was already known from the last enrich pass — it's now seeded from that cached data immediately (a not-yet-installed package gets its known latest version as a single-entry placeholder), while the background refresh that keeps it fresh still runs and updates the list the same as before (#76)
- Most row/button hover states relied only on a `background` swap, and the Restore/Refresh/Trace/filter/dropdown-style buttons relied only on a border/text/icon colour swap to the accent colour — both are invisible (or worse, made the icon vanish into an identically-coloured background) in VS Code's Dark/Light High Contrast themes. Hover now adds a thicker outline alongside the (restored, icon/text left alone) background/border swap — consistently across all of them, not a colour swap to `contrastActiveBorder`, since that orange/yellow tone is reserved for keyboard focus and read as out of place on a plain hover. No-op outside HC themes. Also removed a leftover dead `.log-entry__toggle` rule/reference from before the #58 Log tab redesign (#68)

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
