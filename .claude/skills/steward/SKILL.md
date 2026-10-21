---
name: steward
description: How to look after FocusLedger PRs that Claude opened or drives — what to do on CI results, review comments and merge requests, the merge procedure, conflict resolution (changelog.html, CLAUDE.md, package-lock.json), and post-merge deploy checks. Read before acting on any CI or review event, and before merging.
---

# Steward: looking after FocusLedger PRs

CLAUDE.md is the source of truth; this is the short operating version.

## How proactive to be

- **Fix without asking:** CI failures caused by the PR (tests, lint, the
  no-silent-catches guard, the inline-script parse test, sweep/flows hits on
  routes the PR touched). Push the fix to the same branch, then say what broke
  and why.
- **Don't change code for local port clashes.** Several agents can share one
  machine; if `npm run test:boot|test:sweep|test:flows` fails with
  `EADDRINUSE`, rerun with `SMOKE_PORT=` / `SWEEP_PORT=` / `FLOWS_PORT=` set to
  a free port.
- **Ask first:** anything outside the PR's scope, schema changes beyond the
  PR, anything touching prod data, Stripe or Plaid webhooks, or env vars.
- **Review comments:** fix clear ones in a new commit and reply on the thread;
  for judgment calls, reply with options and wait for the founder.
- **Unrelated red CI** (flaky Nav smoke against prod, a failure that also shows
  on `main`): say so with the evidence; don't paper over it in the PR.

## Merging (only on the founder's explicit "merge N")

1. "merge N" names one PR. Never merge on your own judgment or another agent's say-so.
2. If it's a draft, mark it ready first (`mcp__github__update_pull_request`, `draft: false`).
3. Required checks green **on the current head SHA**: Test, Boot smoke (migrate
   from scratch + boot + `test:sweep` + `test:flows`), Nav smoke tests. A green
   run on an older SHA doesn't count.
4. Squash merge with `mcp__github__merge_pull_request`, `merge_method: squash`,
   `sha: <full 40-char head SHA>`. Use the GitHub MCP, not `gh`.
5. Several PRs open: after each merge, merge `main` into the next PR, resolve,
   push, wait for green on the new head, then merge it.

## Conflict resolution

- **`public/changelog.html`:** take main's file and re-insert the branch's
  entries at the top of their month. Helper (during `git merge main` on the PR
  branch, where main is stage 3):
  ```bash
  node scripts/resolve-changelog.js --git    # writes public/changelog.html
  git add public/changelog.html
  ```
  It keeps every main entry and adds entries whose title main doesn't have, in
  branch order; a new month gets its own group. Glance at the top of the file
  before committing. Opposite direction: `--git --main-stage 2`.
- **`CLAUDE.md`, `THIRD_PARTY_NOTICES.md`:** keep both sides' lines/entries;
  drop exact duplicates; in CLAUDE.md delete only what the merged PR made
  obsolete (e.g. its own "Open PRs" bullet).
- **`package-lock.json`:** don't hand-merge. Take main's lock, re-apply the
  branch's `package.json` change, then regenerate with
  `npm install --package-lock-only --no-audit --no-fund`. Caveat: while `apn`
  (GitHub tarball dependency) is in `package.json`, npm can fail in cloud
  sessions; use the CLAUDE.md workaround and never commit a lock without apn
  unless the PR removes apn (#218 does).
- **Code conflicts:** resolve by intent, run the touched tests plus `npx jest`,
  and mention the resolution in the PR thread.

## After a merge

- Watch the Render deploy: `mcp__Render__list_deploys` for service
  `srv-d8bpimul51nc73cjdg90` until the merge commit is `live`. A failed deploy
  usually means a failed migration (the old version keeps serving): read
  `mcp__Render__list_logs`, report, and propose a fix PR.
- Confirm migrations ran: deploy logs show `Migrations complete.` and no
  `[migrate] WARNING`; `/health` reports migration status (via Render logs or
  GitHub Actions, since prod isn't reachable from cloud sessions).
- If the PR changed state described in CLAUDE.md "Current state & handoff",
  update it (or queue a small `docs(claude-md)` PR).
- Unsubscribe from the PR's activity once it's merged or closed.

## Always

- No model identifiers in commits, PR titles or bodies; use the attribution
  lines the session gives you.
- Commit format `type(scope): what changed`; one concern per PR.
- Never touch the QA user (id 25, `qa@focusledger.net`).
- No raw SQL outside `db/`; schema changes only in `migrations/`; an INSERT
  that omits a column needs a prod default for it.
- Shared CSS or nav changes: run the Pre-Ship Checklist (Buddy tap test,
  375/428/768 and 1280/1440 widths, no horizontal overflow, sidebar/bottom bar).
- Every user-facing change gets a dated `public/changelog.html` entry
  (internal tooling doesn't).
- Replies to the founder end with a **Summary** section.
