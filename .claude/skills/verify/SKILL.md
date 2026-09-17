---
name: verify
description: Stage 4 of the four-stage workflow — verify a finished issue against its plan and mockup, run the checks, update the CHANGELOG and open the pull request. Use when the user types /verify with an issue number, or asks whether an implemented issue is ready.
---

# Stage 4 — verification

The argument is an issue number `NNN`. Come to this with fresh eyes: the point of a separate chat is that the code is read by someone who did not write it.

## Read first

- `docs/plans/NNN-slug.md` — specifically the invariants and the acceptance criteria.
- The mockup it names, if any.
- The diff of the branch against `main`.

## Checks

1. `npm run lint`, `npm run typecheck`, `npm test` — all three, and report the real output. A skipped check is reported as skipped.
2. Walk the acceptance criteria one by one and say, for each, what proves it: a test name, a line of code, or a run of the extension.
3. Where a mockup exists, compare the implementation with it **element by element** — spacing, order, colours, what happens on hover and selection, both themes.
4. Run `/code-review` on the diff. For anything touching credentials, proxies, `nuget.config` secrets or tracing, run `/security-review` as well.
5. When the change is visible in the UI and the criteria cannot be settled by reading, run the extension (F5 / `/run`) and look.

## Produce

- A CHANGELOG entry under `## Unreleased`: one short line, ending with `(#NNN)`. No development history, no rationale, no internal fixes. Create the `## Unreleased` heading if the top section is already released.
- A pull request, on request, with no attribution line and no mention of how it was produced.

## Rules

- **Do not rearchitect.** Small fixes belong here; anything deeper becomes a new plan or a new issue.
- **Report faithfully.** If something fails, say so with the output. If a criterion could not be checked, say which and why, rather than calling the whole thing done.
- **Ask before committing.** Never infer permission to commit from an ambiguous reference to "that item".

## Done when

Every acceptance criterion is confirmed with named evidence, the checks are green, the CHANGELOG line is in place, and `docs/design/README.md` shows the mockup as implemented.
