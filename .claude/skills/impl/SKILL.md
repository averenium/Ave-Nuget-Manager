---
name: impl
description: Implementation stage — implement an issue from its plan, and its mockup when it has one, with tests. Use when the user types /impl with an issue number, or asks to build what an issue's proposal describes.
---

# Implementation

The argument is an issue number `NNN`.

## Read first

- `gh issue view NNN --json number,title,state,labels,milestone,body,comments` — the whole thread, in order. The plan is the body plus every comment that extends it: the design, decisions taken later, items added or dropped. Where a comment and the body disagree, the later one holds. Reading only the body means building a stale plan.
- The mockup the design comment links, when the issue has one. Many do not; that is normal and not a reason to stop.
- The implementation note in `docs/` for the area being changed.

- **One call, and empty is an answer.** The command above returns the body and every comment together; read the thread from it and do not assemble the same picture out of several calls. `gh issue view NNN --comments` is not a substitute: it prints the comment thread *only*, and an issue with no comments yet prints nothing at all and exits 0 — which is the answer "no comments", not a broken tool, not a missing repository and not an authentication problem. Never re-run a variant of a command that already succeeded.

## Build

Work through the numbered items of the proposal in order, as the thread leaves them. For each one, the code and the test that pins it.

- **Tests fail without the fix.** A test that passes on the unchanged code proves nothing. Cover the exact behaviour the issue describes.
- **Async tests use the suite's own `waitFor`**, never a fixed `setTimeout`.
- **Comparisons go through the helpers**: `packageIdsEqual`, `pathsEqual` (`src/pathCompare.ts`), `versionsEqual`, `compareSemVer` (`src/semver.ts`) — including when a version is used as an object key.
- **No new file-system watchers.** Prefer explicit hooks: editor save, force refresh, the extension's own write.
- **Webview diagnostics belong in the Log tab**, not in temporary `console.log` that gets removed afterwards.
- **Follow the mockup element by element** where one exists.

## Rules

- **Do not redesign quietly.** If an item turns out to be wrong or incomplete, say so and put the correction into the issue as a comment. Do not improvise around it and do not silently narrow the scope.
- **Finish the whole proposal,** including the items marked as merely making the result quicker — or say plainly which ones were left out and why. Dropping scope is the user's call.
- **Do not review your own work here.** `/verify` does that with fresh eyes. Finish, run `npm test`, hand over.
- **Yours to touch: `src/` and its tests.** A design chat may be writing in `docs/design/` at the same time; those files are not yours, not leftovers, and not to be reverted or cleaned.
- **Commit as `#NNN short description`**, English, with no attribution trailers, staging your own paths by name. Never `git add -A`, `git add .` or `git commit -a`: it would sweep another chat's half-finished work into your commit. Ask before committing.

## Done when

Every item of the proposal is met, `npm test` is green, and the work is committed. Then hand over to `/verify NNN`.
