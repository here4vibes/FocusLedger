---
name: helper-authoring
description: How to write or adapt a Claude Code helper (a skill in .claude/skills/ or an agent in .claude/agents/) for FocusLedger — frontmatter, a description that actually triggers, keeping the body small, testing it on real prompts, and the review, license and attribution rules for anything taken from another repo. Use whenever you create, edit or import a skill or agent, or someone suggests installing a plugin.
---

<!--
NOTICE: Adapted from anthropics/skills, skills/skill-creator at commit
dbd4588f9e1033efb41dad4bef2f7947c8993d44. Licensed under the Apache License 2.0
(see LICENSE.txt in this directory). Modified for FocusLedger: condensed to the
skill-writing guidance; the eval tooling (scripts/, eval-viewer/, agents/,
benchmarking and description-optimizer loops) was not copied; FocusLedger's
import and attribution rules were added.
-->

# Helper Authoring (FocusLedger)

## The repo's rules for helpers (from CLAUDE.md)

- Helpers live in `.claude/agents/<name>.md` and `.claude/skills/<name>/SKILL.md`. `.gitignore` commits only those two folders (`.claude/*`, then `!.claude/agents/`, `!.claude/skills/`); everything else in `.claude/` stays local.
- **Only reviewed copies go in.** Never install a plugin, hooks, MCP configs or anything that auto-updates. Read every line you bring in.
- Rewrite around CLAUDE.md: house rules (no silent failures, SQL only in `db/`, `[Module]` log prefixes, the QA user is untouchable, no in-process schedulers) beat whatever the upstream text says.
- List every new helper in the CLAUDE.md "Claude Code helpers" bullet, in the same PR.

## Importing from another repo

1. **Check the license of the exact item**, not just the repo. Take only MIT or Apache-2.0. In `anthropics/skills`, `docx`, `pdf`, `pptx` and `xlsx` are proprietary ("All rights reserved"), and `anthropics/claude-code` is under Anthropic's commercial terms; don't copy from those.
2. Record the upstream repo, path and **full commit SHA**.
3. Add a `<!-- NOTICE: ... -->` comment right after the frontmatter: source, commit, license, and what you changed (Apache-2.0 requires stating changes).
4. **Apache-2.0:** put the upstream `LICENSE.txt` next to the `SKILL.md`. **MIT:** the copyright and permission notice go in `THIRD_PARTY_NOTICES.md`.
5. Add an entry to `THIRD_PARTY_NOTICES.md` at the repo root.
6. Don't copy bundled scripts unless you've read them and they fit the stack (Node, not Python, here). Prose that points at the repo's own scripts is usually better.

## Anatomy

```
.claude/skills/<name>/
├── SKILL.md          required: frontmatter (name, description) + instructions
└── references/*.md   optional: longer material the body points to
.claude/agents/<name>.md   frontmatter (name, description, tools) + instructions
```

An agent runs as a subagent with its own context and a `tools:` allow-list; use one for a self-contained review or hunt that reports back (see `silent-failure-hunter`, which is read-only: `Read, Grep, Glob, Bash`). A skill loads into the current conversation; use one for know-how applied while working (see `postgres-patterns`).

## The description does the triggering

Only `name` and `description` are always in context; the body loads when the description matches. So:

- Say **what it does and when to use it**, with the concrete words people will use and the file paths it covers ("Use whenever you change anything in public/...").
- Lean a little pushy: models tend to under-use skills. "Use whenever ..." beats "Can be used for ...".
- Put all "when to use" guidance in the description, not the body.

## Keep the body small

- Aim well under 500 lines; most helpers here are 40–120. Context is limited (CLAUDE.md "stay small").
- Point to the code instead of restating it: name files and functions (`lib/log-failure.js`, `countCappedOpenTasks`) so the reader opens the real thing.
- Move long tables or rarely needed detail to `references/` with a line saying when to read it.
- Write in the imperative and explain **why** a rule exists; a reason generalizes better than a bare MUST.
- Give an exact output format when the helper reports findings (e.g. `file:line · severity · impact · fix`).
- Nothing surprising: a helper must do what its description says, and nothing that touches prod data, secrets or the QA user.

## Test it before the PR

1. Write 2–3 realistic prompts someone would actually type ("the tasks page bounces to Home", "add a Buddy tool to snooze a bill").
2. Run them in a session with the helper present and check it triggers and that the result follows the house rules.
3. If it doesn't trigger, fix the description first. If it triggers but does the wrong thing, fix the body.
4. Keep the prompts in the PR description, not in the repo.
