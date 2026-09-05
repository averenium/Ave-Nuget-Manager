# AVE NuGet Manager

[![Marketplace Version](https://vsmarketplacebadges.dev/version/averenium.averenium-nuget-manager.svg?color=0078d4&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=averenium.averenium-nuget-manager)
[![Marketplace Installs](https://vsmarketplacebadges.dev/downloads-short/averenium.averenium-nuget-manager.svg)](https://marketplace.visualstudio.com/items?itemName=averenium.averenium-nuget-manager)  
[![Open VSX](https://img.shields.io/open-vsx/v/averenium/averenium-nuget-manager?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/averenium/averenium-nuget-manager)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/averenium/averenium-nuget-manager?label=downloads)](https://open-vsx.org/extension/averenium/averenium-nuget-manager)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**A NuGet package manager for your whole .NET solution, in a VS Code panel.** Search, install, update, audit for vulnerabilities and edit `nuget.config` — without hand-editing a `.csproj` or memorising `dotnet` flags.

Works in **VS Code, Cursor, Windsurf, Kiro, VSCodium** and other forks. The only requirement is the **.NET SDK** on `PATH`.


![AVE NuGet Manager](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/hero.gif)

## Why

Visual Studio has a package manager window. VS Code has a terminal. Everything below is what that difference costs on a real solution:

| Without it | With AVE NuGet Manager |
|---|---|
| `dotnet list package --outdated` in every project, then read the text output | One list of every package in every project, with **↑** where a newer version exists |
| Remember to run `--vulnerable` now and then | **⚠** marks kept in sync after every install, with the advisory explained in the details panel |
| `dotnet add package` per id, per project — and a failed restore leaves the repo half-bumped | Update a package **family** or the **whole solution** in one pass, with automatic rollback on `NU1605` |
| Find which `nuget.config` in the chain actually wins, then edit XML | The resolved chain in one editor: sources, credentials, API keys, `packageSourceMapping` |
| "Is this bump safe?" — read the release notes yourself | A bundled **agent skill** that collects the release notes for every changed package and drafts a breaking-changes review |

No account, no sign-in, no telemetry: the extension shells out to your local `dotnet` and nothing else. It stays usable under **High Contrast** themes and Windows **forced colors**, which most webview panels do not.

## Install

| Editor | Where |
|---|---|
| VS Code | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=averenium.averenium-nuget-manager) — or search **AVE NuGet Manager** in the Extensions view |
| Cursor, Windsurf, VSCodium, Gitpod, Eclipse Theia | [Open VSX](https://open-vsx.org/extension/averenium/averenium-nuget-manager) — the registry those editors use by default, so the same search works there |
| Air-gapped or a specific build | Download the `.vsix` from [Releases](https://github.com/averenium/Ave-Nuget-Manager/releases) and run **Extensions: Install from VSIX…** |

Both registries carry the same build from the same tag.

## Quick start

1. Open a folder containing a `.sln`, `.slnx`, `.csproj` or `.fsproj`.
2. Open the **NuGet** tab in the Panel — or run **NuGet: Management** from the Command Palette.
3. Pick a scope when asked: the solution, a single project, or **Manage all N projects in this folder** for a folder of loose projects with no solution file.

`dotnet` runs only after you open the panel, so the extension costs nothing until you use it.

## Features

### Packages — everything installed, in one place

Installed, implicit and transitive packages, plus catalog search. The details panel shows the current restore graph, and **Problems** explains anything wrong with a row: a vulnerability advisory, a blocked update, or a **∅** mark for an installed id that matches no `<packageSourceMapping>` pattern on any source — the failure that would otherwise only appear as a broken `dotnet restore`.


![Packages tab](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/packages.png)

### Groups — bump a family or the whole solution

Update **All**, a package **family** (`Microsoft.Extensions.*`, `OpenTelemetry.*`, …) or **Other**, with a **Stop** button while it runs. Packages that fail one at a time only because a sibling `ProjectReference` needs them bumped together are detected and applied in one `--no-restore` pass, then validated with a single restore at the end — instead of every item in the batch failing and rolling back individually.

![Groups batch update](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/groups.png)

### Vulnerabilities — checked, not guessed

Marks come from `dotnet list package --vulnerable` and follow the restore graph, so a package you only pull in transitively is still flagged. `averenium.nugetManager.vulnerabilityScript` can add findings from your own source (an internal feed, a corporate scanner) over a simple JSON protocol — see [docs/vulnerability-script.md](docs/vulnerability-script.md).

![Vulnerability details](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/vulnerabilities.png)

### Sources — the whole `nuget.config` chain

Toggle sources on and off, edit credentials, API keys and HTTP flags, and manage `packageSourceMapping` patterns per source (comma-separated, e.g. `Example.*, Internal.*`) — across the machine, user and repository configs at once, without opening any of them.

![Sources tab](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/sources.png)

### Agent skill — review a bump before you take it

The panel installs packages; it does not judge whether a bump is safe. The **Agents** tab installs a **Dependency breaking-changes review** skill for Cursor, Claude Code or Kiro. Its bundled script reads your pending manifest diff, restores the dependency graph and collects every changed package's release notes, so the agent reviews real upstream notes instead of guessing. Details: [docs/agent-skill.md](docs/agent-skill.md).

![Agents tab](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/agent-skill.png)

### Block updates — pin what must not move

Right-click a package in **Packages** or a **Groups** preview and choose **Block updates**. The row keeps a **⊘** mark, batch updates skip it, and a click on **↑** only explains that it is pinned. The list lives in `.vscode/settings.json` (`averenium.nugetManager.blockedPackages`), so the pin is shared with the repository rather than living on one machine.

This is for the bump you already know you cannot take yet — `RabbitMQ.Client` 6.x to 7.x while half your libraries are still built against 6.x is the standing example. NuGet version ranges are minimums, so a restore of that bump succeeds without a warning and breaks at runtime instead; a pin is what stops it from being taken by an "update all" on a Friday.

![Block updates](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/block-updates.png)

### Log and Trace — a bug report worth filing

Every `dotnet` command the extension ran, with the full output, a failure-aware summary and a clickable `NU-code` chip. **● Trace** records a sanitised zip — workspace paths, host name, project names and credentials replaced — that you can attach to a GitHub issue without leaking anything about your repository.

![Log tab](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/log.png)

### High Contrast — usable, not just installable

Every button, tab and status mark (**↑ / ⊘ / ⚠ / ∅**) keeps a real border or
outline under VS Code's **High Contrast** themes and Windows **forced colors**,
instead of relying on a colour swap that those modes discard. Hover is a visible
outline change rather than a background tint, so a control never disappears into
an identically-coloured background, and the marks are fixed-coordinate SVG icons
rather than Unicode glyphs, so they stay centred and legible at any font.

![High Contrast theme](https://raw.githubusercontent.com/averenium/Ave-Nuget-Manager/main/media/high-contrast.png)

## Where the panel lives

Drag the view **title bar** (or **View: Move View**) to the sidebar, the secondary sidebar or the panel. **Open in New Window** hosts the same UI as an editor tab in its own window. The **gear** opens this extension's settings.

You can also reach it from the Explorer context menu on a `.sln` / `.slnx` / `.csproj` / `.fsproj`, and switch scope by clicking the solution or project name in the panel's tab bar.

## Settings

The gear on the **NuGet** title bar (or **NuGet: Open Settings**) opens them.

| Setting | Default | |
|---|---|---|
| `averenium.nugetManager.includePrerelease` | `false` | Pre-release versions in search and "latest". |
| `averenium.nugetManager.dotnetConcurrency` | `4` | Max parallel `dotnet` processes (list, search, enrich, install, remove, restore). |
| `averenium.nugetManager.onFailedUpdate` | `rollback` | After a failed restore (`NU1605`): roll back the project file, or keep the version and show **Rollback**. |
| `averenium.nugetManager.vulnerabilityScript` | `""` | Optional script adding extra vulnerability findings (JSON on stdin/stdout). See [docs/vulnerability-script.md](docs/vulnerability-script.md). |
| `averenium.nugetManager.blockedPackages` | `[]` | Workspace package ids that must not change version. Right-click a row to block or unblock. |

## Requirements and limits

- The **.NET SDK** must be on `PATH`; VS Code **1.85** or newer.
- CLI backend only (no NuGet HTTP catalog yet): **↑**, Groups and the version list use feed latest from `dotnet package search`, not the newest version that restores on this project's target framework. The **Current Dependencies** tree is the restore graph of the *installed* version.
- **Groups** will not target `Microsoft.CodeAnalysis.*` above the Roslyn version bundled with the active SDK. **Packages** still lists nuget.org latest and asks before an over-cap upgrade.
- Scope is `.csproj` / `.fsproj` in the first workspace folder — a solution, a project, or a folder of loose projects.
- `packages.config` projects are skipped. Legacy non-SDK `.csproj` using `PackageReference` is updated in the XML, then restored.
- Removing a source does not clean up its now-orphaned `packageSourceMapping`, credentials or `disabledPackageSources` entries elsewhere in the chain.

## Contributing

Bugs and feature requests: [GitHub Issues](https://github.com/averenium/Ave-Nuget-Manager/issues). A **Trace** zip attached to the report is the fastest path to a fix. Implementation notes live in [docs/](docs/README.md).

If the extension saves you time, a rating on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=averenium.averenium-nuget-manager&ssr=false#review-details) or a star on [Open VSX](https://open-vsx.org/extension/averenium/averenium-nuget-manager) helps other .NET developers find it.

## License

MIT — see [LICENSE](LICENSE).
