---
name: impl
description: Stage 3 of the four-stage workflow — implement an issue from its plan and mockup, with tests. Use when the user types /impl with an issue number, or asks to build what a plan under docs/plans/ describes.
---

# Stage 3 — implementation

The argument is an issue number `NNN`.

## Read first

- `docs/plans/NNN-slug.md` — the whole plan, including the invariants and the acceptance criteria.
- The mockup it names, if any.
- The implementation note in `docs/` for the area being changed.

## Build

Work through the plan's acceptance criteria in order. For each one, the code and the test that pins it.

- **Tests fail without the fix.** A test that passes on the unchanged code proves nothing. Cover the exact behaviour the issue describes.
- **Async tests use the suite's own `waitFor`**, never a fixed `setTimeout`.
- **Comparisons go through the helpers**: `packageIdsEqual`, `pathsEqual` (`src/pathCompare.ts`), `versionsEqual`, `compareSemVer` (`src/semver.ts`) — including when a version is used as an object key.
- **No new file-system watchers.** Prefer explicit hooks: editor save, force refresh, the extension's own write.
- **Webview diagnostics belong in the Log tab**, not in temporary `console.log` that gets removed afterwards.
- **Follow the mockup element by element** where one exists.

## Rules

- **Do not redesign quietly.** If the plan turns out to be wrong or incomplete, write the correction into the plan and tell the user. Do not improvise around it and do not silently narrow the scope.
- **Do not review your own work here.** Stage 4 does that with fresh eyes. Finish, run `npm test`, hand over.
- **Commit as `#NNN short description`**, English, with no attribution trailers. Ask before committing.

## Done when

Every acceptance criterion in the plan is met, `npm test` is green, and the work is committed. Then hand over to `/verify NNN`.
