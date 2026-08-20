---
name: dependency-breaking-changes-review
version: "1.0.6"
description: >-
  Reviews NuGet package version bumps for real breaking changes using official
  release notes and the restore graph (resolved / transitives / diamonds),
  not an empty git diff. Use when the user asks to review a dependency update,
  a Directory.Packages.props / *.csproj / .deps.json / .nupkg diff, or whether
  a bump breaks the solution; also when checking transitive majors under EF
  Core, Aspire, or similar.
---

# Dependency Breaking Changes Review

Instructions for an agent with git, fetch, and a shell. This extension does **not** run the review.

NuGet / .NET only. Details: [nuget.md](references/nuget.md).

## Trigger On

- User asks to analyze a dependency / library version update, or “did this bump break anything”
- `git diff` of `Directory.Packages.props`, `*.csproj`, `.deps.json`, or `.nupkg`

## Four rules

**1. Empty code diff is not “no breaking change.”** Grep coming back empty only means nobody adapted yet. Every bumped id needs an authoritative source (specific GitHub **release/tag** URL, `CHANGELOG.md`, umbrella notes, or a file inside the cached `.nupkg`). Never write “compatible” from a landing-page search snippet. “Checked GitHub” / “verified via search” with no link is not a source.

**2. Read every release in the range**, not only the newest tag. `8.0.0 → 8.7.0` includes 8.1 … 8.7. A break documented only on 8.3 still ships in 8.7. List tags between old and new (inclusive of new, exclusive of old) before concluding Compatible. For a long patch train, scan titles for risk markers (`breaking`, `removed`, `renamed`, major dependency bump, `+semver:major`) and fully read those. A “minor” bump can still document a break — magnitude is not a skip. If you use an aggregated Releases / milestone page, confirm it actually starts at or before the old version (default pagination often shows only recent tags).

**3. Direct major bump → check key transitives.** A major on EF Core / Aspire / an SDK meta-package often pulls a major on a driver (e.g. Npgsql) that never appears in `Directory.Packages.props`. Same if the direct package’s own notes call this a breaking release, or if restore (below) shows a **transitive major** that the manifest did not pin. How to see current transitives without guessing: [nuget.md](references/nuget.md). Check only the handful the project code is exposed to (DB driver, HTTP, serialization) — not every leaf. Say which were in scope.

**4. Always analyze the restore graph (no gate).** Notes do not show what NuGet unified. Same review as the notes: `dotnet restore`, `dotnet list --include-transitive`, `dotnet nuget why` on shared / surprising ids, and `obj/project.assets.json` for requested ranges (diamonds). Patch/minor included. Do not wait to be asked. Do not require a major bump. Do not start `dotnet build` for this — assets after restore are enough. Failed restore → graph **Unverified**, not Compatible. Details: [nuget.md](references/nuget.md).

## Workflow

1. List every changed package id and old → new from the manifest diff (`Directory.Packages.props`, `PackageReference`). Note patch/minor/major, but do not skip a package because the bump looks small.
2. **Restore and read the graph** (Rule 4) in the same pass as notes — do not finish a notes-only review first. Prefer `packages.lock.json` diff if committed. Record requested vs resolved, transitives, shared ids, diamonds.
3. For each id, fetch notes for the **range** (Rule 2). Search for Breaking, warning markers, BREAKING CHANGE, migration guide, removed/renamed API, minimum-dependency bumps. Notes are not a substitute for restore.
4. On a direct major, an explicitly labeled breaking release, **or** a transitive major the graph just revealed, apply Rule 3 (read those transitives’ notes).
5. Only then grep the codebase for flagged APIs — diff is for impact, not for discovering breaks.
6. For a real impact: what changed upstream, why it matters here, the exact file/config, and a concrete remediation or verification step. For no impact: quote or paraphrase the cited notes. Private / no-GitHub packages: inspect `~/.nuget/packages/<id>/<version>/` (`CHANGELOG.md`, `RELEASENOTES.md`, `.nuspec` `releaseNotes`). Unverified must say the cache was inspected and what was tried.
7. Write the report file. Chat is a summary + path. Both use the **same language as the user's request** (see Output).

Never use restore *instead of* reading notes. Never ship notes without the graph.

## Output

Always write a `.md` file. Chat alone is not done.

**Language:** write the report (and the chat summary) in the language of the user's request. Package ids, versions, file paths, and source URLs stay as-is. Do not default to English if the user wrote in another language.

Path: reuse this workspace’s existing docs/planning layout if there is one. Otherwise:

`docs/dependency-reviews/YYYY-MM-DD-package-updates.md`

## Deliver

- Every bumped id: old → new, and **Breaking** (impact + file/config + remediation) / **Compatible** (citation) / **Unverified** (what was tried, e.g. changelog too large at a URL)
- Every notes claim: real URL (release **tag** page, changelog path, official docs) or a local cache path for private packages. If the range crossed several tags, list URLs for the ones that had a risk marker — not only the newest tag
- Restore graph: requested vs resolved, notable transitives, diamonds / shared unified versions (or Unverified if restore failed)
- Rule 3: which transitives were checked / out of scope, with URLs
- Runtime/smoke tests that static reading cannot confirm

## Validate

- No id in the diff silently omitted
- No “no breaking changes” without a cited source URL or cache path
- No vague “checked GitHub” / “verified via search”
- Range of tags accounted for, not only the newest
- Graph analysis is in the same report as the notes (restore + list + assets.json diamonds), or Unverified with the restore error
- Direct majors — and transitive majors the graph revealed — have key transitives’ notes checked
- Huge/unreadable changelogs → Unverified, not Compatible
- Flagged breaks grepped in project code before high/low risk
- Report file exists on disk
- Report language matches the user's request
