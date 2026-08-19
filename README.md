# AVE NuGet Manager

**Preview.** A NuGet manager for Visual Studio Code and Cursor, inspired by JetBrains Rider.

Opens in the **Panel** (`NuGet`): search and install packages, scan advisories, update families, inspect `nuget.config`, and read `dotnet` output.

Requires the **.NET SDK** on `PATH`.

## Install (preview)

1. Install from the Marketplace **Pre-release** channel, or
2. `Extensions: Install from VSIX…` with a `.vsix` built from this repo.

## Open

- Command Palette: **C# Solution / C# Project: NuGet Management**
- Explorer context menu on a `.sln` / `.slnx` / `.csproj` / `.fsproj`

## Tabs

| Tab | What it does |
|---|---|
| **Packages** | Installed, implicit, catalog search. Details, install / update / remove. Vulnerability marks from `dotnet list --vulnerable`. |
| **Groups** | Update **All**, package **families** (`Microsoft.Extensions.*`, …), or **Other**. |
| **Sources** | Read-only `nuget.config` chain. |
| **Log** | `dotnet` commands this extension ran. |

## Settings

| Setting | Default | |
|---|---|---|
| `averenium.nugetManager.includePrerelease` | `true` | Pre-release versions in search and “latest”. |
| `averenium.nugetManager.enrichConcurrency` | `4` | Parallel `dotnet` processes when fetching latest versions. |
| `averenium.nugetManager.onFailedUpdate` | `rollback` | After a failed restore (`NU1605`): roll back the project file, or keep the version and show **Rollback**. |
| `averenium.nugetManager.vulnerabilityScript` | `""` | Optional script that adds extra vulnerability findings (JSON on stdin/stdout). |

## Known limits (preview)

- CLI backend only (no NuGet HTTP catalog yet): package metadata has no TFM / catalog dependency graph for a *selected* version. The **Current Dependencies** tree is the restore graph of the *installed* version.
- Scope: `.csproj` / `.fsproj` in the first workspace folder (or the opened solution).
- Package sources are read-only.

## License

MIT. Issues: [GitHub](https://github.com/averenium/Ave-Nuget-Manager/issues).
