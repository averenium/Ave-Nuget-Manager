---
name: dependency-breaking-changes-review
version: "1.1.0"
description: >-
  Reviews NuGet package version bumps for real breaking changes using official
  release notes and the restore graph (resolved / transitives / diamonds),
  not an empty git diff. Use whenever the user wants a NuGet/.NET package
  or dependency update looked at, analyzed, checked, or reviewed — including
  generic phrasing like "analyze the package changes," "check these
  dependency bumps," "what changed in this update," or "is it safe to merge
  this" for a diff touching Directory.Packages.props / *.csproj / .deps.json
  / .nupkg — not only requests that name "breaking changes" outright. Also
  use when checking transitive majors under EF Core, Aspire, or similar.
---

# Dependency Breaking Changes Review

Instructions for an agent with git, fetch, and a shell. This extension does **not** run the review.

NuGet / .NET only. Details: [nuget.md](references/nuget.md).

## Trigger On

- User asks to analyze, check, or review a dependency/library/package update, or "did this bump break anything" — including looser phrasing that doesn't name "breaking changes" explicitly: "analyze the package changes," "look at these dependency bumps," "what changed in this update," "is this safe to merge"
- `git diff` of `Directory.Packages.props`, `*.csproj`, `.deps.json`, or `.nupkg` — even without an explicit request, if the user is asking about the state of the repo/PR in a way that implies this diff matters
- Do **not** require the phrase "breaking change(s)" to trigger — a plain "review/check/analyze the package(s)" on a repo with a pending manifest bump is enough

## Four rules

**1. Empty code diff is not “no breaking change.”** Grep coming back empty only means nobody adapted yet. Every bumped id needs an authoritative source (specific GitHub **release/tag** URL, `CHANGELOG.md`, umbrella notes, or a file inside the cached `.nupkg`). Never write “compatible” from a landing-page search snippet. “Checked GitHub” / “verified via search” with no link is not a source.

**2. Read every release in the range**, not only the newest tag. `8.0.0 → 8.7.0` includes 8.1 … 8.7. A break documented only on 8.3 still ships in 8.7. List tags between old and new (inclusive of new, exclusive of old) before concluding Compatible. For a long patch train, scan titles for risk markers (`breaking`, `removed`, `renamed`, major dependency bump, `+semver:major`) and fully read those. A “minor” bump can still document a break — magnitude is not a skip. If you use an aggregated Releases / milestone page, confirm it actually starts at or before the old version (default pagination often shows only recent tags).

**3. Direct major bump → check key transitives.** A major on EF Core / Aspire / an SDK meta-package often pulls a major on a driver (e.g. Npgsql) that never appears in `Directory.Packages.props`. `diff` flags candidates for this automatically (`"transitiveMajorHints"` on a `"changed"` entry whose own major moved — see nuget.md) by comparing the bumped package's own declared dependency versions, old vs new; `graph`'s diamond/crossing check is a *different*, narrower signal (internal graph conflicts) that does **not** catch this case on its own — a transitive quietly following its parent to a new major, with no conflict anywhere, produces no crossing. Same trigger if the direct package's own notes call this a breaking release, or `graph` shows a transitive major the manifest did not pin. Check only the handful the project code is exposed to (DB driver, HTTP, serialization) — not every leaf. Say which were in scope.

**4. Always analyze the restore graph (no gate).** Notes do not show what NuGet unified. Prefer the bundled script (below) — one pass instead of a `dotnet nuget why` per shared/transitive id, and it already computes diamonds and transitive major-version crossings instead of leaving that to eyeballing raw JSON. Patch/minor included. Do not wait to be asked. Do not require a major bump. Do not start `dotnet build` for this — assets after restore are enough. Failed restore → graph **Unverified**, not Compatible. Details: [nuget.md](references/nuget.md).

## Script (preferred path for Rules 1, 2 and 4)

`scripts/review.fsx`, run with `dotnet fsi` (no project file, no build step, works with any .NET SDK on PATH). Full command reference, JSON shapes, and the manual fallback: [nuget.md](references/nuget.md).

```bash
dotnet fsi scripts/review.fsx -- diff [<base-ref>] [--no-notes] [--out <dir>]
dotnet fsi scripts/review.fsx -- graph <path> [--out <dir>]
dotnet fsi scripts/review.fsx -- notes <packageId> <oldVersion> <newVersion>
```

- `diff` = Workflow step 1 (every changed id, old → new) **and** step 3 (release notes per id, fetched in parallel) in one call, unless `--no-notes` — plus Rule 3's "did this direct major bump drag a transitive with it" hints on any major-bumped id, no restore needed. `graph` = Rule 4's mechanical check (diamonds, internal graph major crossings — a different, narrower signal than `diff`'s transitive hints, see Rule 3). `notes` = the same per-id lookup, callable standalone.
- `"resolution": "unresolved-manual-required"` from `notes` is **not** permission to write Unverified — work through nuget.md's fallback chain first (migration guide, a downstream package's own notes, direct API usage in this repo).
- Script unavailable, or any subcommand errors (`"ok": false`, or a non-JSON line) → fall back to nuget.md's manual commands. Never skip Rules 1/2/3/4 because the script didn't run.
- A bump touching many ids, or `graph` on a large solution: add `--out <dir>` — writes `<dir>/diff.json`+`.md` (plus `release-notes.md`; `graph` writes `graph.json`+`.md`) there, only a short summary to the conversation. Point it at a **timestamped scratch directory in the workspace root** — `.dependency-review-YYYYMMDD-HHMMSS/` — never at the report path itself, and **delete that directory once the report is written**, unless the user asked to keep the working artifacts. Keep it inside the workspace rather than a system temp path: write access there is the one thing that can be relied on, and `dotnet fsi` is a .NET process that cannot resolve a Git-Bash `/tmp/…` path anyway. Only the dated report is a deliverable (see Output).
- **Read `.md` directly, in full — it's the one meant for that.** It's already the pre-filtered, human-readable form of the same data (roughly a third of the JSON's size: one short section per package/project, no raw dump duplicated), so open it with a plain `Read` before touching anything else. This is the opposite advice from the JSON file below — don't apply the "never unbounded" rule to `.md`, and don't re-derive with `grep`/`jq`/a one-off script what `.md` already states in prose (a real review once re-queried `diff.json` by hand for release URLs/bodies/resolutions that `diff.md` already had written out, because the file it should have opened first was never opened at all).
- **`release-notes.md` is for the reader, not for you — never `Read` it.** `diff.md` deliberately cuts a non-flagged release's body to a one-line excerpt, because those are Dependabot "Bump …" lists far more often than signal (in one real review, reading them whole was the single largest line item in the whole run). The same releases' *full* text is written to `release-notes.md` instead, so the finished review can carry it for a human without any of it passing through this conversation: append that file to the report with a shell redirect (`cat <dir>/release-notes.md >> <report>.md`), don't open it. If a specific release genuinely needs a closer look, it is flagged — and a flagged release's body is already in `diff.md` in full.
- **Never `Read` the `--out` **`.json`** file start-to-front.** It exists specifically so the full JSON doesn't have to pass through the conversation — an un-bounded `Read` defeats that and can burn most of the context window on `bodyPreview` text before hitting the tool's own output cap. Query it first (`grep`/`jq`/a one-off script) for exactly what's needed — `packageId`, `"hasRiskMarker": true`, `"resolution"` not `"ok"` — then `Read` with a precise `offset`/`limit` around just those matches. Reach for this only for something `.md` doesn't already show well (cross-package structured filtering, `graph.json`'s full diamond list).
- **`"commitFallback"`/`"releases"` (already risk-marker-scanned) before anything external, and never a guessed versioned doc URL.** A GitHub id with nothing in either field is the rare case, not the default — read them first. Only when both are genuinely empty is an external doc site worth a look, and even then check one root/index page before constructing a versioned path (`/22x.html`-style) nothing on hand actually confirmed — see nuget.md.

## Workflow

1. Run `dotnet fsi scripts/review.fsx -- diff [<base-ref>]` (add `--out <dir>` if the bump touches many ids — see Script above) for every changed package id and old → new (fall back to reading the manifest diff by hand, `Directory.Packages.props`/`PackageReference`, only if the script can't run). Note patch/minor/major, but do not skip a package because the bump looks small. An `"added"`/`"removed"` entry has no version range to check notes for — say so rather than treating it as Unverified.
2. **Restore and read the graph** (Rule 4) in the same pass as notes — do not finish a notes-only review first. Run `dotnet fsi scripts/review.fsx -- graph <path>` first (add `--out <dir>` for a large solution); fall back to `packages.lock.json` diff / the manual commands in nuget.md only if the script can't run. Record requested vs resolved, transitives, shared ids, diamonds.
3. For each id, read the `"notes"` field `diff` already fetched (or run `dotnet fsi scripts/review.fsx -- notes <id> <old> <new>` standalone if `diff` was run with `--no-notes`) for the **range** (Rule 2), then read the releases (and follow the manual fallback in nuget.md if `"resolution"` is not `"ok"`). Search for Breaking, warning markers, BREAKING CHANGE, migration guide, removed/renamed API, minimum-dependency bumps. Notes are not a substitute for restore.
4. On a direct major, an explicitly labeled breaking release, **or** a transitive major the graph just revealed, apply Rule 3 (read those transitives’ notes).
5. Only then grep the codebase for flagged APIs — diff is for impact, not for discovering breaks.
6. For a real impact: what changed upstream, why it matters here, the exact file/config, and a concrete remediation or verification step. For no impact: quote or paraphrase the cited notes. Private / no-GitHub packages: inspect `~/.nuget/packages/<id>/<version>/` (`CHANGELOG.md`, `RELEASENOTES.md`, `.nuspec` `releaseNotes`). Unverified must say the cache was inspected and what was tried.
7. Write the report file, append the release-notes appendix to it (`cat <out-dir>/release-notes.md >> <report>.md`), then delete the `--out` scratch directory unless the user asked to keep the working artifacts. Chat is a summary + path. Both use the **same language as the user's request** (see Output).

Never use restore *instead of* reading notes. Never ship notes without the graph.

## Output

Always write a `.md` file. Chat alone is not done.

**Language:** write the report (and the chat summary) in the language of the user's request. Package ids, versions, file paths, and source URLs stay as-is. Do not default to English if the user wrote in another language.

Path: reuse this workspace’s existing docs/planning layout if there is one. Otherwise:

`docs/dependency-reviews/YYYY-MM-DD-package-updates.md`

The report ends with the upstream release notes in full, as an appendix — the reader should be able to check any verdict against the actual published text without leaving the document. Do not retype or summarize them into it and do not read them to do so: `diff --out <dir>` already wrote exactly that appendix to `<dir>/release-notes.md`, so append it as the last step (`cat <dir>/release-notes.md >> docs/dependency-reviews/YYYY-MM-DD-package-updates.md`).

**`--out` goes to a timestamped scratch directory in the workspace root**, e.g. `.dependency-review-20260905-113000/`, which is **deleted once the report is written and the appendix appended** — unless the user asked to keep the working artifacts. In the workspace, because that is where write access can be relied on; timestamped, so a re-run can't overwrite a run still being read; its own directory, so cleanup is one removal rather than five files to pick out. Only the dated report belongs in the repo for good: `diff.json`/`diff.md`/`graph.json`/`graph.md`/`release-notes.md` are one review's working data, regenerable in seconds, and the earlier convention of aiming `--out` at `docs/dependency-reviews` left all five sitting next to the deliverable to be committed by accident — which is exactly what happened on a real review. Delete only that scratch directory; never the report.

`diff.md`/`graph.md` already carry every mechanical fact the deliverable needs per id/project (URLs, release/commit bodies, `resolution`, transitive-major hints, an already-filled `Verdict` line for a same-major id) — read it (in full, see Script above) and pull those facts straight into `YYYY-MM-DD-package-updates.md` instead of re-deriving them from the raw JSON or a fresh `gh api`/`grep` lookup. Its flat one-section-per-package layout is a checklist that nothing got skipped, not a template to preserve as-is — grouping by project, collapsing trivial same-major ids into a table, and reserving prose for the ids that actually need it usually makes a better deliverable than copying `diff.md`'s structure verbatim.

## Deliver

- Every bumped id: old → new, and **Breaking** (impact + file/config + remediation) / **Compatible** (citation) / **Unverified** (what was tried, e.g. changelog too large at a URL)
- Every notes claim: real URL (release **tag** page, changelog path, official docs) or a local cache path for private packages. If the range crossed several tags, list URLs for the ones that had a risk marker — not only the newest tag
- Restore graph: requested vs resolved, notable transitives, diamonds / shared unified versions (or Unverified if restore failed)
- Rule 3: which transitives were checked / out of scope, with URLs
- Runtime/smoke tests that static reading cannot confirm
- The upstream release notes in full, appended as the report's last section from `release-notes.md` (appended with a shell redirect, never retyped or summarized into it)

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
- Release-notes appendix is present at the end of the report when `diff` ran with `--out`
- The `--out` scratch directory is deleted, and no `diff.json`/`diff.md`/`graph.json`/`graph.md`/`release-notes.md` is left in the workspace (unless the user asked to keep them)
