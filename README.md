# AVE NuGet Manager

A NuGet manager for Visual Studio Code, Cursor, Kiro, etc.

Opens in the **Panel** (`NuGet`): search and install packages, scan advisories, update families, inspect `nuget.config`, and read `dotnet` output.

Requires the **.NET SDK** on `PATH`.

## Features

- **Packages** — search, install, update, remove; vulnerability marks from `dotnet list --vulnerable`.
- **Groups** — batch-update All / a package family / Other in one go, with **Stop**.
- **Sources** — full `nuget.config` chain editor: add/remove sources, enable/disable, credentials, API key, HTTP flags.
- **Trace** — one-click sanitized zip of the relevant `dotnet` output and config for a GitHub issue.
- **Agent skill** — installs a dependency **breaking-changes review** skill for Cursor / Claude / Kiro.
- **Folder scope** — manage a folder of loose `.csproj`/`.fsproj` with no `.sln` as one group, no solution file required.
- **Block updates** — pin a package version per workspace so a bump doesn't happen by accident.
- Accessible under VS Code **High Contrast** themes and Windows forced colors.

## Install

1. Install from the Marketplace, or
2. `Extensions: Install from VSIX…` with a `.vsix` built from this repo.

## Open

The **NuGet** panel tab is shown when the workspace contains a `.sln`, `.slnx`, `.csproj`, or `.fsproj`. Opening the folder activates the extension enough to show the tab; `dotnet` runs only after you open NuGet.

Three scopes are supported: a **solution**, a single **project**, or a **folder of projects with no solution** — pick **Manage all N projects in this folder** when the panel offers it, and every project inside is managed as one group.

Drag the view **title bar** (or **View: Move View**) to the sidebar / secondary sidebar / panel. **Open in New Window** (title menu) hosts the same UI as an editor tab in a new window. The **gear** opens this extension’s Settings.

- Command Palette: **NuGet: Management**
- Explorer context menu on a `.sln` / `.slnx` / `.csproj` / `.fsproj`
- Click the solution/project name in the panel tab bar to switch among `.sln` / `.slnx` / `.csproj` / `.fsproj` in the workspace

Buttons, tabs, and status marks (↑ / ⊘ / ⚠) stay visible under VS Code's **High Contrast** themes and Windows **forced colors** — not just color-only, they draw a real border/outline in those modes.

## Agent skill

The panel does not review whether a bump is safe. The **Agents** tab (after Log) explains and installs the **Dependency breaking-changes review** skill. If a copy is already on disk and older than the VSIX, **Update** writes the bundled files to that path (no folder picker). Palette **NuGet: SKILL -> Install Dependency Breaking Changes Review** still uses QuickPick for a first install. Details: [docs/agent-skill.md](docs/agent-skill.md).

## Tabs

| Tab | What it does |
|---|---|
| **Packages** | Installed, implicit, catalog search. Details, install / update / remove. Vulnerability marks from `dotnet list --vulnerable`. A **∅** mark flags an installed package that matches no `<packageSourceMapping>` pattern on any source — restore will fail to find it. |
| **Groups** | Update **All**, package **families** (`Microsoft.Extensions.*`, …), or **Other**. Packages that would fail one-at-a-time only because a sibling `ProjectReference` needs them bumped together are added with `--no-restore` and validated with a single restore at the end, instead of restoring after every individual package. |
| **Sources** | `nuget.config` chain: toggle on/off, edit credentials / API key / HTTP flags, and **packageSourceMapping** patterns per source (comma-separated, e.g. `Contoso.*, Fabrikam.*`). |
| **Log** | `dotnet` commands this extension ran. **● Trace** records a sanitised zip for a GitHub issue; **Clear log** wipes the list. |
| **Agents** | Install or **Update** the dependency-review skill (files only; the panel does not run the agent). |

## Under the hood

- **Entangled-cluster batch updates** — in **Groups**, a package can fail one-at-a-time purely because a sibling `ProjectReference` requires it and another package in the same batch to land together (a version floor). Those are detected and applied with `--no-restore`, then validated with a single restore at the end — instead of every item in the batch failing (and rolling back) one by one.
- **Package source mapping** — edit `packageSourceMapping` glob patterns per source (comma-separated, e.g. `Contoso.*, Fabrikam.*`) directly from **Sources**. Packages gets a **∅** mark on any installed id that matches no pattern on any source once mapping is active — the same condition that would otherwise only surface as a `dotnet restore` failure.

## Block updates

Pin a package so its **version cannot change** in this workspace until you unblock it. Use this when a bump is likely to break the restore graph (a new major, a transitive conflict, or a package the rest of the solution is not ready for). **✕ Remove** still works; installing an id that is not yet in Installed is still allowed.

**How**

1. Right-click a row in **Packages** (Installed) or in a **Groups** preview.
2. Choose **Block updates**. The row stays visible, with **⊘** next to the name. **↑** still shows if a newer version exists, but a click only explains that updates are blocked.
3. **Groups** still lists blocked packages on the right (muted, **⊘**, no green `from → to`). Left-side counts skip them; **↑** on All / a family / Other updates only the rest. If every item in the selection is blocked, **↑** does not run an update.
4. Right-click again and choose **Unblock updates** when you are ready to bump.

The list is stored in workspace settings (`.vscode/settings.json`, `averenium.nugetManager.blockedPackages`) so the pin is shared with the repo, not only on your machine.

## Settings

Gear on the **NuGet** title bar (or Command Palette **NuGet: Open Settings**) opens the Settings UI for this extension.

| Setting | Default | |
|---|---|---|
| `averenium.nugetManager.includePrerelease` | `false` | Pre-release versions in search and “latest”. |
| `averenium.nugetManager.dotnetConcurrency` | `4` | Max parallel `dotnet` processes (list, search, enrich, install, remove, restore). |
| `averenium.nugetManager.onFailedUpdate` | `rollback` | After a failed restore (`NU1605`): roll back the project file, or keep the version and show **Rollback**. |
| `averenium.nugetManager.vulnerabilityScript` | `""` | Optional script that adds extra vulnerability findings (JSON on stdin/stdout). Details: [docs/vulnerability-script.md](docs/vulnerability-script.md). |
| `averenium.nugetManager.blockedPackages` | `[]` | Workspace package ids that must not change version (Packages **↑** and Groups). Right-click a row to block or unblock. |

## Known limits

- CLI backend only (no NuGet HTTP catalog yet): package metadata has no TFM / catalog dependency graph for a *selected* version. **↑** / Groups / the version list use feed latest from `dotnet package search`, not the latest that restores on this project’s TFM. The **Current Dependencies** tree is the restore graph of the *installed* version.
- **Groups** will not target `Microsoft.CodeAnalysis.*` above the Roslyn version bundled with the active .NET SDK (`csc -version`). **Packages** still lists nuget.org latest and asks before an over-cap upgrade.
- Scope: `.csproj` / `.fsproj` in the first workspace folder — a solution, a project, or a folder of loose projects.
- `packages.config` projects are skipped (legacy csproj with `PackageReference` is updated in the XML, then `dotnet restore`).
- Removing a source does not clean up its (now orphaned) `packageSourceMapping`, credentials, or `disabledPackageSources` entries elsewhere in the chain.

## License

MIT. Issues: [GitHub](https://github.com/averenium/Ave-Nuget-Manager/issues).
