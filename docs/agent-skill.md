# Agent skill (dependency review)

The extension does **not** review bumps itself. It ships a **project Agent Skill** (`skills/dependency-breaking-changes-review/`) and a command that **copies** that folder where Claude Code / Cursor / Kiro / Agents / Antigravity already look.

## Contents

| File | Role |
|---|---|
| `SKILL.md` | Triggers, four rules, workflow, report path, validate |
| `references/nuget.md` | `.deps.json` resolved graph, cache `CHANGELOG.md`, gated diamond check |

Report files the agent writes: existing docs/planning layout in **that** workspace, else `docs/dependency-reviews/YYYY-MM-DD-package-updates.md`.

## Command

`averenium.nugetManager.installAgentSkill` — Palette **NuGet: SKILL -> Install Dependency Breaking Changes Review**, and the mortar-board icon on the NuGet view / editor title.

QuickPick (detected agents first, **Custom folder…** last):

| Label | Destination |
|---|---|
| Kiro (user) | `~/.kiro/skills/dependency-breaking-changes-review/` |
| Kiro (this workspace) | `<workspace>/.kiro/skills/…/` |
| Claude Code (user) | `~/.claude/skills/…/` |
| Claude Code (this workspace) | `<workspace>/.claude/skills/…/` |
| Cursor (user) | `~/.cursor/skills/…/` |
| Cursor (this workspace) | `<workspace>/.cursor/skills/…/` |
| Agents (user) | `~/.agents/skills/…/` |
| Agents (this workspace) | `<workspace>/.agents/skills/…/` |
| Antigravity (user) | `~/.gemini/antigravity/skills/…/` |
| Custom folder… | folder picker; creates `…/dependency-breaking-changes-review/` inside |

`~` = `os.homedir()`. Host copies files (`fs`); the webview cannot write outside its sandbox. We do **not** invoke `claude` / `cursor` / `kiro` to register the skill — those CLIs just read the folder.

Detection (any one hit): `kiro` / `kiro-cli` / `~/.kiro`; `claude` / `~/.claude`; `cursor` / `cursor-agent` / `~/.cursor`; `amp` / `~/.agents` / `~/.config/agents`; `antigravity` / `~/.gemini/antigravity`. Undetected targets stay in the list, below.

If the destination folder already has files: compare them to the bundled skill. Identical → already up to date, no copy. Different → modal **Overwrite** / **Cancel** (never silent). Same `version` with different files, or extra files the bundle does not ship, is treated as local edits — the prompt says those changes will be discarded. A version bump also warns that the whole folder is replaced. Copy is temp-dir then rename (no half-written dest on failure).

After copy: information message with the path. Does **not** start the agent or register a plugin.

Code: `src/agentSkillInstall.ts`.
