# Daily Standup

Run a daily standup for FocusLedger. Do all of the following automatically:

1. **Git status** — run `git log --oneline -10` and `git status` to see what shipped and what's pending
2. **Open PRs** — run `gh pr list` to see any open pull requests
3. **Priority check** — cross-reference recent commits against the known priority list in CLAUDE.md
4. **Recommend** — give a ranked list of 3 things to tackle today, with a one-line reason each

Format your output like this:

---
## FocusLedger Standup — [today's date]

**Shipped recently:**
- [commits from git log]

**Open PRs:**
- [from gh pr list]

**Today's top 3:**
1. [task] — [why it's #1]
2. [task] — [why]
3. [task] — [why]

**Recommended first move:** [one specific action to take right now]
---
