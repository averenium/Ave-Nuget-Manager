---
name: dependency-breaking-changes-review
version: "1.0.4"
description: >-
  Reviews NuGet package version bumps for real breaking changes using official
  release notes (not an empty git diff). Use when the user asks to review a
  dependency update, a Directory.Packages.props / *.csproj / .deps.json /
  .nupkg diff, or whether a bump breaks the solution; also when checking
  transitive majors under EF Core, Aspire, or similar.
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

**3. Direct major bump → check key transitives.** A major on EF Core / Aspire / an SDK meta-package often pulls a major on a driver (e.g. Npgsql) that never appears in `Directory.Packages.props`. Same if the direct package’s own notes explicitly call this a breaking release. How to see current transitives without guessing: [nuget.md](references/nuget.md). Check only the handful the project code is exposed to (DB driver, HTTP, serialization) — not every leaf. Say which were in scope.

**4. `.deps.json` / diamond check is gated.** Run it only after a **major** bump **and** Rule 3, or if the user asks about version conflicts. Confirm with the user before `dotnet build` of a large/slow solution. Patch/minor with no diamond signal: skip.

## Workflow

1. List every changed package id and old → new from the manifest diff (`Directory.Packages.props`, `PackageReference`). Note patch/minor/major, but do not skip a package because the bump looks small. Resolved transitives: [nuget.md](references/nuget.md).
2. For each id, fetch notes for the **range** (Rule 2). Search for Breaking, warning markers, BREAKING CHANGE, migration guide, removed/renamed API, minimum-dependency bumps.
3. On a direct major (or an explicitly labeled breaking release), apply Rule 3 before moving on.
4. If Rule 3 found a shared transitive under several directs, apply Rule 4.
5. Only then grep the codebase for flagged APIs — diff is for impact, not for discovering breaks.
6. For a real impact: what changed upstream, why it matters here, the exact file/config, and a concrete remediation or verification step. For no impact: quote or paraphrase the cited notes. Private / no-GitHub packages: inspect `~/.nuget/packages/<id>/<version>/` (`CHANGELOG.md`, `RELEASENOTES.md`, `.nuspec` `releaseNotes`). Unverified must say the cache was inspected and what was tried.
7. Write the report file. Chat is a summary + path. Both use the **same language as the user's request** (see Output).

**Restore / build:** `dotnet restore`, `dotnet list package --include-transitive`, and `dotnet build` change the machine. Say so before running. Never restore/build as a substitute for reading notes.

## Output

Always write a `.md` file. Chat alone is not done.

**Language:** write the report (and the chat summary) in the language of the user's request. Package ids, versions, file paths, and source URLs stay as-is. Do not default to English if the user wrote in another language.

Path: reuse this workspace’s existing docs/planning layout if there is one. Otherwise:

`docs/dependency-reviews/YYYY-MM-DD-package-updates.md`

## Deliver

- Every bumped id: old → new, and **Breaking** (impact + file/config + remediation) / **Compatible** (citation) / **Unverified** (what was tried, e.g. changelog too large at a URL)
- Every notes claim: real URL (release **tag** page, changelog path, official docs) or a local cache path for private packages. If the range crossed several tags, list URLs for the ones that had a risk marker — not only the newest tag
- Rule 3: which transitives were checked / out of scope, with URLs
- Rule 4: if run — shared id, mismatch or not, recommended smoke test
- Runtime/smoke tests that static reading cannot confirm

## Validate

- No id in the diff silently omitted
- No “no breaking changes” without a cited source URL or cache path
- No vague “checked GitHub” / “verified via search”
- Range of tags accounted for, not only the newest
- Direct majors have key transitives checked
- Shared transitives after Rule 3 → `.deps.json` (or equivalent) if Rule 4 applies
- Huge/unreadable changelogs → Unverified, not Compatible
- Flagged breaks grepped in project code before high/low risk
- Report file exists on disk
- Report language matches the user's request
