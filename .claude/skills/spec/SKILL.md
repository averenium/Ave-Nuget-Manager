---
name: spec
description: Stage 1 of the four-stage workflow — work an issue through into a written plan under docs/plans/. Use when starting a new issue, before any code or mockup exists, or when the user types /spec with an issue number.
---

# Stage 1 — working the issue through

The argument is an issue number `NNN`, or a description if there is no issue yet.

## Read first

- The issue itself (`gh issue view NNN`), if it exists.
- `docs/README.md` and whichever implementation note covers the area being touched.
- The code that would change. Enough of it to know what is actually there, not what the issue assumes is there.
- `docs/design/README.md`, in case a mockup for this area already exists.

## Produce

`docs/plans/NNN-slug.md`, following the template in `docs/plans/README.md`, in Ukrainian.

The section that matters most is **Критерії готовності**: a list of checkable statements. Stage 3 builds against it and stage 4 checks against it, so anything vague there turns into an argument two chats later.

## Rules

- **No code.** Not even a small fix along the way. Work in plan mode; if something obviously needs fixing, record it in the plan or as a separate issue.
- **Ask.** This is the stage where questions are cheap. Ambiguity resolved here costs one message; resolved in stage 3 it costs a rewrite. Put every answer into the plan — an answer that stays in the chat is lost to the next stage.
- **Name the trade-off.** When alternatives were considered, the plan says which one was chosen and why, so stage 3 does not reopen it.
- **Check the invariants against the code**, not against memory. The HTTP catalog in particular has rules of its own in `docs/http-backend-plan.md`.

## Done when

The plan reads as executable by someone who never saw this conversation, and it is committed (ask before committing). Then say which stage comes next: `/design` if the issue touches the UI, `/impl` if it does not.
