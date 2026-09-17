---
name: design
description: Stage 2 of the four-stage workflow — turn a plan into an HTML mockup under docs/design/ and iterate on variants until one is chosen. UI issues only. Use when the user types /design with an issue number, or asks for a mockup of a UI change.
---

# Stage 2 — the mockup

The argument is an issue number `NNN`. Skip this stage entirely for work with no UI — the HTTP catalog, parsers, `nuget.config`, logging.

## Read first

- `docs/plans/NNN-slug.md` — the plan is the brief.
- `docs/design/README.md` and the neighbouring mockups, for the house style.
- The current UI in `src/webview/` — the components and styles that would change, so the mockup shows what is really there.

## Produce

`docs/design/<slug>.html` — one self-contained file, opened in a browser, English throughout, `<title>` in the form `Something — design for #NN`. Register it in `docs/design/README.md` with its issue and status.

## Rules

- **Variants side by side.** Two to four honest options in one file, each with a line on what it costs. Not one proposal defended.
- **Mark the chosen one.** When the user picks, either delete the rest or add an explicit `Chosen: …` heading saying why. A file that leaves the variants equal is not finished: stage 3 will guess.
- **Untouched elements stay untouched.** Everything that is not the subject of the discussion is drawn exactly as it looks in the extension today — no incidental change of size, style or position. An accidental difference reads as a requirement.
- **Both themes when colour is at stake.** Light and dark side by side. The light theme needs a darker, calmer colour than the raw warning gold the dark theme keeps, so the two cannot be derived from each other.
- **Reused CSS classes are scoped.** If the design leans on an existing shared class, say in the mockup that only the new element changes.
- **Real constraints.** The panel is short — a few hundred pixels — and package ids are long. A mockup that only works at a comfortable width is not a design.
- **Sample data uses the reserved names**: `Example.*`, `example.com`.

## Done when

One variant is chosen and marked, the index row exists, and the plan's `Макет:` line points at the file. Anything the design changed about behaviour goes back into the plan — the plan stays the single source for stage 3.
