# AVE NuGet Manager — working notes

VS Code / Cursor extension (`averenium-nuget-manager`): a NuGet package manager whose UI follows JetBrains Rider — a webview in the bottom panel with the tabs Packages, Groups, Sources, Log and Agents.

## Commands

```
npm run build        # build:ext (tsc) + build:webview (vite)
npm test             # jest --runInBand — the whole suite
npm run test:unit    # src/test/unit only
npm run lint         # eslint src
npm run typecheck    # both tsconfigs, no emit
```

F5 in VS Code / Cursor starts the Extension Host (`Run Extension`, preLaunchTask `build:all`).

## Layout

- `src/*.ts` — extension host: activation, commands, nuget.config chain, HTTP catalog (`nugetHttp*`, `nuget*`), vulnerabilities, logging and tracing.
- `src/backend/` — `INuGetBackend`, the CLI backend and the HTTP backend behind it.
- `src/webview/` — the React UI (`App.tsx`, `components/`, `context/`, `styles/`). It talks to the host only through the message protocol in `src/messages.ts`.
- `src/test/unit`, `src/test/property`, `src/test/fixtures`, `src/test/__mocks__` — Jest; `vscode` is mocked, `@/x` maps to `src/x`.
- `docs/` — implementation notes, in Ukrainian; `docs/README.md` is the index.
- `docs/design/` — HTML mockups; `docs/design/README.md` is the index.

## How work is split

There are four stages, each with its own chat and its own skill in `.claude/skills/`: `/spec` investigates a symptom or an idea and writes the plan into its issue, creating that issue when there is none yet, `/design` settles how it looks, `/impl` builds it, `/verify` checks it. **They are stages a task may need, not a sequence every task runs through.** Most issues never need `/design`; a small, well-understood fix can go straight to `/impl`. Skip what is not needed rather than producing an empty artifact to complete the set. What a stage does produce is left where the next one can read it — never in chat history.

**Stages run in parallel.** Implementation of one issue and design of another go on at the same time, in this same working directory and on the same branch. They stay out of each other's way because they write to different places: `/design` to `docs/design/`, `/impl` to `src/`, `/verify` to `CHANGELOG.md`. The rule that makes it safe is about git: **stage only the paths your own stage produced.** No `git add -A`, no `git add .`, no `git commit -a` — one of those once swept a half-finished set of files from another chat into an unrelated commit. The working tree is dirty at all times; another chat's modified or untracked files are not leftovers, are not yours to revert or clean, and are not a reason to wait.

**The plan lives in the issue — the whole thread, not only the body.** The body opens it: what happens today, what the code does now with file and line references, and a numbered proposal whose items are checkable one by one. Comments extend it — the design once it is settled, a decision taken after discussion, a section that refines or replaces part of the original proposal. Read the plan with `gh issue view NNN --comments`, and where a comment and the body disagree, the later one holds. A separate document under `docs/` is only for a subject large enough to describe permanently, the way `docs/http-backend-plan.md` covers the move to the HTTP catalog. The skills in `.claude/skills/` describe what each stage reads and writes.

## Conventions

- **Attribution.** Never add a "generated with Claude" marker to anything: no `Co-Authored-By` trailer in commits, no "Generated with Claude Code" line in pull requests, nothing of the sort in issues, plans or the CHANGELOG.
- **Commits.** `#NNN short description`, English, one issue per commit where possible. Do not commit unless asked.
- **Language.** English for code, comments, commit messages, pull requests, issues, CHANGELOG and the root README. Ukrainian for the internal notes under `docs/`. The mockups under `docs/design/` are in English.
- **CHANGELOG.** One short line per issue under `## Unreleased`, ending with `(#NNN)`. No development history, no rationale, no internal fixes. Create the `## Unreleased` heading when the top section is an already released version.
- **Comparisons.** Use the repo helpers, never `===`, `toLowerCase()` or `indexOf`: `packageIdsEqual` and `pathsEqual` (`src/pathCompare.ts`), `versionsEqual` and `compareSemVer` (`src/semver.ts`). This holds when a version is used as an object key too.
- **UI.** When a mockup exists in `docs/design/`, the implementation is checked against it element by element before it is called done. Elements the mockup does not discuss keep exactly the look they already have.
- **Themes.** A light theme needs a darker, calmer colour than the theme's raw warning gold, while the dark theme keeps that gold — colour work is asymmetric and has to be seen in both themes.
- **Shared CSS.** When an existing class is reused for a new element, scope the restyling to the new element; current users of that class keep their look.
- **Watchers.** Prefer explicit hooks — editor save, force refresh, the extension's own write — over file-system watchers and change events.
- **Diagnostics.** When a webview problem needs visibility, add it to the extension's own Log tab instead of temporary `console.log`.
- **Tests.** A fix ships with a test that fails without it and pins the exact behaviour that broke. Async tests use the suite's own `waitFor`, not a fixed `setTimeout`.
- **Sample names.** Use the reserved `Example.*` / `example.com` names, never Contoso, Fabrikam or an invented brand.
