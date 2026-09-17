---
name: verify
description: Verification stage — verify a finished issue against its proposal, and its mockup when it has one, run the checks, update the CHANGELOG and open the pull request. Use when the user types /verify with an issue number, or asks whether an implemented issue is ready.
---

# Verification

The argument is an issue number `NNN`. Come to this with fresh eyes: the point of a separate chat is that the code is read by someone who did not write it.

## Read first

- `gh issue view NNN --comments` — the whole thread. The checklist is the numbered proposal as the comments leave it: items added later count, items superseded do not, and the design comment is the visual checklist.
- The mockup the design comment links, when the issue has one.
- The diff of the branch against `main`.

## Checks

1. `npm run lint`, `npm run typecheck`, `npm test` — all three, reporting the real output. A skipped check is reported as skipped.
2. Walk the numbered items one by one and say, for each, what proves it: a test name, a line of code, or a run of the extension.
3. Where a mockup exists — many issues have none — open it (`preview_start url=file:///D:/Repository/plugins/code/nuget-manager/docs/design/<slug>.html`) and compare the implementation with it **element by element** — spacing, order, colours, what happens on hover and on selection, both themes, and every state the mockup draws.
4. Run `/code-review` on the diff. For anything touching credentials, proxies, `nuget.config` secrets or tracing, run `/security-review` as well.
5. When the change is visible in the UI and an item cannot be settled by reading, run the extension (F5 / `/run`) and look.

## Produce

- A CHANGELOG entry under `## Unreleased`: one short line, ending with `(#NNN)`. No development history, no rationale, no internal fixes. Create the `## Unreleased` heading if the top section is already released.
- `docs/design/README.md` updated to show the mockup as implemented, when there is one.
- A pull request, on request, with no attribution line and no mention of how it was produced.

## Rules

- **Do not rearchitect.** Small fixes belong here; anything deeper becomes a comment on the issue or a new issue.
- **Report faithfully.** If something fails, say so with the output. If an item could not be checked, say which and why, rather than calling the whole thing done.
- **Yours to touch: `CHANGELOG.md` and `docs/design/README.md`,** plus whatever small fix this verification turned up in `src/`. Other chats are working in the same tree; stage your paths by name and never `git add -A`.
- **Ask before committing,** and before posting anything to the issue or the pull request. Never infer permission from an ambiguous reference to "that item".

## Done when

Every item of the proposal is confirmed with named evidence, the checks are green, the CHANGELOG line is in place, and the design index is current if the issue had a mockup.
