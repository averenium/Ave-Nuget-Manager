---
name: verify
description: Verification stage — find the problems in a finished change, and check it against its issue and its mockup; run the checks, update the CHANGELOG and open the pull request. Use when the user types /verify with an issue number, or asks whether an implemented issue is ready.
---

# Verification

The argument is an issue number `NNN`. Come to this with fresh eyes: the point of a separate chat is that the code is read by someone who did not write it.

This stage has two jobs, and **finding the problems is the main one**. Checking the work against its issue only establishes that the plan was followed; it says nothing about whether the code is right. A report that walks the items, finds them all present and stops has done half the work.

## Read first

- `gh issue view NNN --json number,title,state,labels,milestone,body,comments` — the whole thread. The checklist is the numbered proposal as the comments leave it: items added later count, items superseded do not, and the design comment is the visual checklist.
- The mockup the design comment links, when the issue has one.
- The diff of the branch against `main`.

- **One call, and empty is an answer.** The command above returns the body and every comment together; read the thread from it and do not assemble the same picture out of several calls. `gh issue view NNN --comments` is not a substitute: it prints the comment thread *only*, and an issue with no comments yet prints nothing at all and exits 0 — which is the answer "no comments", not a broken tool, not a missing repository and not an authentication problem. Never re-run a variant of a command that already succeeded.

## Checks

1. `npm run lint`, `npm run typecheck`, `npm test` — all three, reporting the real output. A skipped check is reported as skipped.
2. Walk the numbered items one by one. See **How to report an item** below: state what the code does now, never the item's own sentence with a mark attached.
3. Where a mockup exists — many issues have none — open it (`preview_start url=file:///D:/Repository/plugins/code/nuget-manager/docs/design/<slug>.html`) and compare the implementation with it **element by element** — spacing, order, colours, what happens on hover and on selection, both themes, and every state the mockup draws.
4. Read the diff on its own terms — see **Looking for problems**. `/code-review` is one instrument for this and `/security-review` another for anything touching credentials, proxies, `nuget.config` secrets or tracing; neither replaces reading the change yourself.
5. When the change is visible in the UI and an item cannot be settled by reading, run the extension (F5 / `/run`) and look.

## Looking for problems

Read the diff as a reviewer, not as a checklist-holder. What is worth looking for, in roughly this order:

- **Defects in what was written.** The case the code gets wrong: an off-by-one, a comparison that should have gone through `packageIdsEqual` or `versionsEqual`, a promise nobody awaits, state written in one place and read before it is set.
- **Regressions around it.** Every other caller of a function whose signature or behaviour moved, and every path the changed component is also on. This is where a change that satisfies its issue perfectly still breaks something else.
- **Cases the plan never considered.** Empty result, single result, very many results; cancellation; a feed that answers slowly, refuses, or is unreachable; a solution with one project and one with forty; a package present only transitively.
- **What the user will meet.** A state with no message, a message that describes the wrong thing, a control that stays enabled while it cannot act, a wait with nothing on screen.
- **What it costs.** Requests added per package or per row, work repeated on every render, a fan-out that grows with the size of the solution.
- **What ships untested.** Behaviour that would break silently because no test would catch it — in particular the exact thing the issue was about.

Each problem is reported with where it is (`file.ts:line`), what goes wrong and in which situation, and whether it blocks the change or is worth a separate issue. Severity is stated in words. Finding nothing is a legitimate result, but only after looking, and it is said that way — "nothing found in X, Y, Z", not silence.

## How to report an item

Each item is reported as a sentence about the present, written in your own words, followed by what establishes it — a file and line, a test name, or what was seen when the extension was run.

- **No status emoji.** No ✅, no ❌, no ticks or crosses. This project's issues and documents are plain prose and bold; a mark is not a finding.
- **Do not echo the proposal.** Copying the numbered item and putting a mark in front of it leaves the reader unable to tell a plan from a fact: the sentence still reads as intent while the mark silently does the asserting. Say what is there instead.
- **The verdict is in the sentence.** "The panel body is the chooser: `PackagesTab.tsx:194` renders `ScopeChooser` in place of `SplitPane` while `chooserVisible`, and the host sends `scopeChoices` with a null scope (`webviewMessageBroker.ts:820`, test *sends scopeChoices on INIT_STATE with a null scope instead of giving up*)." — not "1. The panel body becomes the chooser — ✅ …".
- **Say what kind of evidence it is.** Reading the code and running the extension are different claims. If an item was confirmed by reading only, say that; do not let a test name imply the behaviour was watched.
- **Partly done is written out**, naming what is missing, not softened into a symbol.

## Produce

- A CHANGELOG entry under `## Unreleased`: one short line, ending with `(#NNN)`. No development history, no rationale, no internal fixes. Create the `## Unreleased` heading if the top section is already released.
- `docs/design/README.md` updated to show the mockup as implemented, when there is one.
- A pull request, on request, with no attribution line and no mention of how it was produced.

## Rules

- **Never report a problem you have not traced.** A suspicion is worth raising as a question, labelled as one. A guess presented as a finding costs the implementation chat more than it saves.
- **Do not rearchitect.** Small fixes belong here; anything deeper becomes a comment on the issue or a new issue.
- **Report faithfully.** If something fails, say so with the output. If an item could not be checked, say which and why, rather than calling the whole thing done.
- **Yours to touch: `CHANGELOG.md` and `docs/design/README.md`,** plus whatever small fix this verification turned up in `src/`. Other chats are working in the same tree; stage your paths by name and never `git add -A`.
- **Ask before committing,** and before posting anything to the issue or the pull request. Never infer permission from an ambiguous reference to "that item".

## Done when

The diff has been read for problems and each one found is reported with its place, its failure case and whether it blocks; every item of the proposal is answered with named evidence; the checks are green; the CHANGELOG line is in place; and the design index is current if the issue had a mockup.
