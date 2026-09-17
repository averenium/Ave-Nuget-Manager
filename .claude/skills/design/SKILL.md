---
name: design
description: Optional design stage — turn an issue into an HTML mockup under docs/design/, iterate on variants until one is chosen, and record the decision as a comment on the issue. Only for issues that change what the user sees, which most are not. Use when the user types /design with an issue number, or asks for a mockup of a UI change.
---

# The mockup

The argument is an issue number `NNN`.

**This stage is optional and most issues do not need it.** It earns its place only when the issue changes what the user sees *and* there is a real choice about how. It is not needed for work under the hood — the HTTP catalog, parsers, `nuget.config`, logging — nor for a fix that restores the appearance that was always intended, a wording change, or a change with one obvious form. In those cases say so and go to `/impl`; do not draw a mockup to complete the set.

## Read first

- `gh issue view NNN --comments` — the brief is the whole thread: the proposal in the body plus whatever the comments have since added or changed. **List the decisions already accepted there before drawing anything**, and treat that list as binding; a mockup that quietly drops an accepted decision is wrong even if it looks better.
- `docs/design/README.md` and a neighbouring mockup, for the house style.
- The current UI in `src/webview/` — the components, styles and strings that would change. Read them; the mockup has to show what is really there, and nothing in it may be recalled or assumed.

## Produce

Three things:

1. **`docs/design/<slug>.html`** — one self-contained file opened in a browser, English throughout, `<title>` in the form `Something — design for #NN`. Register it in `docs/design/README.md` with its issue and status.
2. **The page, opened in front of the user.** A mockup nobody looked at is not a deliverable. Open it in the browser pane as soon as the first draft exists:

   ```
   preview_start url=file:///D:/Repository/plugins/code/nuget-manager/docs/design/<slug>.html
   ```

   A local file is rendered as a static snapshot taken when the page opens, so **open it again after every edit** — reloading shows the old snapshot. Take a screenshot afterwards: it confirms the page actually drew, and it is how you check your own work against the rules below before handing it over.
3. **A comment on the issue** recording what was decided and why, opening with a link to the mockup as a relative blob path, e.g. ``[`docs/design/folder-scope-chooser.html`](../blob/main/docs/design/folder-scope-chooser.html)``. The comment carries the reasoning — what the layout gives the reader, what was deliberately not drawn, what stays unchanged. Someone reading only the issue should understand the design without opening the file. Show it to the user and post it only after they agree.

## Rules

- **Yours to touch: `docs/design/` only.** Another chat is working in `src/` at the same time. Stage those paths by name if the user asks for a commit — never `git add -A` — and leave everything else in the working tree alone.
- **Show every iteration, not just the last.** The user changes their mind by looking. Each round is: edit the file, open it again, say what changed — not a description of what they would see if they opened it.
- **Nothing in the mockup is invented.** Every element of the current state — rows, labels, numbers, badges, order, colours — comes from the code or from the issue thread. Where a detail of today's behaviour is not known, ask; do not approximate it. An invented detail does not merely look wrong: the implementation stage reads it as a requirement and builds it.
- **Everything already accepted is in there.** The decisions taken in the issue thread are drawn, all of them. If one of them now looks wrong, say so and let the user decide — do not silently design around it.
- **Variants side by side.** Two to four honest options in one file, each with a line on what it costs. Not one proposal defended, and never a single option presented as the answer.
- **The choice is the user's.** The first delivery contains **no** `Chosen:` heading. Lay out the options, say what each costs, name a recommendation in the chat if there is one, and stop. The `Chosen: … — why` heading is added, and the losing variants deleted, only after the user has named the variant. Choosing on their behalf removes the decision this whole stage exists for.
- **Untouched elements stay untouched.** Everything that is not the subject of the discussion is drawn exactly as it looks in the extension today — no incidental change of size, style or position. An accidental difference reads as a requirement.
- **Draw the states, not just the shape.** First open, the same screen reached later, what happens on hover and on selection, and the way back — those are where the design is actually decided.
- **Both themes when colour is at stake.** Light and dark side by side. The light theme needs a darker, calmer colour than the raw warning gold the dark theme keeps, so one cannot be derived from the other.
- **Reused CSS classes are scoped.** If the design leans on an existing shared class, say in the mockup that only the new element changes.
- **Real constraints.** The panel is short — a few hundred pixels — and package ids are long. A mockup that only works at a comfortable width is not a design.
- **Sample data uses the reserved names**: `Example.*`, `example.com`.

## Done when

This stage has two ends, and the first is not the second.

**The draft is ready** when the variants are laid out, the current state in each is traceable to the code, every accepted decision from the thread is visible, and the page is open in the pane. Hand it over and wait.

**The stage is finished** when the user has chosen, the file carries `Chosen: … — why` with the losing variants gone, the index row exists, and the issue carries the comment linking the file. Nothing further is obligatory — add a summary of the current items only if the thread has grown hard to follow. Anything the design changed about behaviour goes back into the issue as part of that comment, naming the proposal item it affects — the issue stays the single source for implementation.
