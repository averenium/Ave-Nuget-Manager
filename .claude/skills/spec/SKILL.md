---
name: spec
description: Planning stage — investigate a bug or an idea, then write the plan into a GitHub issue, creating that issue when it does not exist yet. Use when the user reports a symptom, describes something to build, types /spec with or without an issue number, or asks for an issue to be created from a finding.
---

# Working the task through

The argument is one of three things:

- **an issue number** — `/spec 113`: the plan exists, work it further;
- **a rough issue** — a number whose body is a placeholder such as "Package reference + Update bug": investigate it and give it a real plan;
- **nothing but a symptom or an idea** — "package list flickers after an update", "we should cancel in-flight requests": investigate it, then create the issue.

**The plan goes into the issue, not into a file — and it is the whole thread.** The body opens the plan; comments extend it as the work is thought through. The later stages read all of it. A separate document under `docs/` is reserved for a subject large enough to be described permanently, the way `docs/http-backend-plan.md` covers the move to the HTTP catalog; everything smaller stays in the issue.

## Read first

- `gh issue view NNN --json number,title,state,labels,milestone,body,comments` — when a number was given, one call for the body and every comment, since the plan is the whole thread.

- **One call, and empty is an answer.** The command above returns the body and every comment together; read the thread from it and do not assemble the same picture out of several calls. `gh issue view NNN --comments` is not a substitute: it prints the comment thread *only*, and an issue with no comments yet prints nothing at all and exits 0 — which is the answer "no comments", not a broken tool, not a missing repository and not an authentication problem. Never re-run a variant of a command that already succeeded.
- `docs/README.md` and the implementation note covering the area being touched.
- The code that would change. Enough of it to know what is actually there, not what the issue assumes is there.
- `docs/design/README.md`, in case a mockup for this area already exists.
- A recent worked-out issue (`gh issue view 113 --json body,comments`) for the house shape.

## Starting from a symptom, with no issue yet

This is the common case and the investigation is the whole value. Do not open an issue that only restates what the user said.

1. **Pin the symptom.** What is on screen, in which tab, after which action. If it is reproducible, say exactly how; if it appeared once, say that instead of inventing steps.
2. **Trace the actual mechanism in the code.** Follow the data from where it is produced to where it is rendered, and name the real identifiers: which component, which message, which field, with `file.ts:line`. A plausible explanation that was not traced is worse than none, because the implementation stage will build on it.
3. **Expect more than one cause.** A symptom often needs two independent things to go wrong; find them all and number them, because fixing one leaves the bug alive.
4. **Say what works nearby, and why.** The path that behaves correctly usually explains the broken one — that vulnerabilities do mark transitive rows, say, because they come from the restore graph rather than from the feed.
5. **Record what you found while tracing.** An adjacent defect belongs in the same issue when one fix covers both, and in its own issue when it does not.
6. **Search for duplicates** before creating anything: `gh issue list --state all --search "<keywords>"`.

## Produce

An issue body in English, in the shape this project already uses. Headings follow the material rather than a fixed template — a bug typically reads as: the symptom; then one section per cause, named for what is wrong; then **`## What it would take`**. A feature reads as: `## What happens` — `## What <the code> does today` — `## Proposal`.

Whatever the headings, three things must be there:

- **the symptom or the need**, concrete and in the present tense;
- **what the code does today**, with `file.ts:line` references covering the case the issue turns on;
- **numbered items of work**, each stated so that it can be confirmed or refused on its own, closing with which are the core and which only make the result quicker.

Where an item carries a real cost — more requests, a bigger fan-out, a visible trade-off — do not pick silently: state the honest options with what each costs, and say which items stand regardless. Anything that constrains the work — invariants, protocol shapes, feed behaviour that must not regress — goes inside the relevant item rather than left implicit.

**Title**: a sentence that says what is wrong, usually prefixed with the area — `Package list: a transitive package's deprecation shows everywhere except the list`. If a rough issue already exists, offer a better title along with the analysis.

**Labels**: `bug`, `enhancement`, `accessibility` as they apply; `gh label list` has the rest. Ask about the milestone rather than assuming one.

For an issue that already has a plan, prefer **a comment** over rewriting the body: a section that adds items, settles a question or replaces part of the proposal, saying plainly which earlier point it supersedes. The body is edited only when what is there has become misleading rather than merely incomplete — the thread should stay readable as the history of the decision. A placeholder body is exactly that case, so there the body may be replaced.

## Rules

- **Nothing is written to the repository at all** — this stage's output is the issue. Other chats are working in the same tree; leave their files alone.
- **No code.** Not even a small fix along the way. Work in plan mode; if something obviously needs fixing, record it as its own item or its own issue.
- **Ask.** Ambiguity resolved here costs one message; resolved during implementation it costs a rewrite. Every answer goes into the issue, as a comment if the body is already written — an answer that stays in the chat is lost to the next stage.
- **Name the trade-off.** When alternatives were weighed, say which was chosen and why, so the implementation stage does not reopen it.
- **Check against the code, not from memory.** The HTTP catalog in particular has invariants of its own in `docs/http-backend-plan.md`.
- **Show before posting.** The issue tracker is public. Put the finished text in front of the user and run `gh issue create --title … --body-file … --label …`, `gh issue edit NNN --body-file …` or `gh issue comment NNN --body-file …` only after they agree. Report the number of whatever was created. No mention of how the text was produced.

## Done when

The issue reads as executable by someone who never saw this conversation, and its number is known. Then say which stage comes next: `/design NNN` when the task changes what the user sees and how it should look is still open, `/impl NNN` otherwise — which is the usual case.
