# Buddy Brain Unification Plan

Why: Buddy overpromised four times this session (email, reminders, recurrence,
edit-task) — always the same root cause. There are **two brains** and a brittle
client-side regex decides which one each message hits. Every phrase the regex
misses ("nudges", "nightly", …) lands in the brain that can't act, which then
narrates a confident confirmation it cannot deliver.

## The two brains today
| | `/api/agent/act` (action) | `/api/buddy/conversation` (coaching) |
|---|---|---|
| Tools (create/update/reschedule/complete task, email) | ✅ | ❌ |
| Coaching persona / "soul" | thin | ✅ rich (becoming, ADHD-from-inside, ask-don't-advise) |
| Passive capture of tasks/expenses | ❌ | ✅ (regex `extractPassiveCapture`) |
| Auto-complete detection ("I finished X") | ❌ | ✅ (`detectCompletions`) |
| Conversation logging (first-session insight, day-2 hook) | ❌ | ✅ |
| Journal archive of the chat | ❌ | ✅ |
| Reports only what it actually did | ✅ | ❌ **(fabricates)** |

Client router (`weightless.html send()`): `moneyIntent` → money; `actionIntent` (regex) → `/act`; else → `/conversation`.

## Target
**One brain per message.** It coaches warmly, acts via tools, captures via
judgment, logs the conversation, and reports only what it actually did. The LLM —
not a client regex — decides act vs. talk. Then Buddy *cannot* claim an action it
didn't take, and the whole class of routing bugs disappears.

## The one real design decision
**Capture moves from regex → the brain's own tool calls.** When you mention a
to-do, the brain calls `create_task`; when you say you finished something,
`mark_task_done`. This is more intelligent (judges intent) and truthful (only
claims what it did) — but we must prompt it to reliably grab *real* to-dos so the
"brain-dump → sorted" value isn't lost, and conservatively so the generic-autofill
problem doesn't return.

## Slices (safe, incremental)
- **U1 — Build the unified brain, server-only.** Evolve `/act` into the one brain:
  port the coaching persona + add conversation logging + journal archive. No client
  change yet, so the live flow is untouched and this ships dormant.
- **U2 — Flip the client.** `weightless.html` sends every message to the unified
  brain; delete the `actionIntent` regex routing. One small, revertible change —
  **you test it live** before anything is retired. (Money stays a deterministic
  shortcut or becomes a `get_spending_summary` tool.)
- **U3 — Tune capture.** Make sure the brain reliably + conservatively captures
  to-dos / completions / expenses from natural mention. Your eyes needed here.
- **U4 — Retire `/conversation`** and the dead routing code once parity is confirmed.

## Risk & rollback
This is the core interaction, so: build U1 without touching the live flow; make U2
a single revertible commit you validate live (as we've done all session); retire
old code only after parity. The behavior change (LLM-judged capture/coaching) is
exactly why U2 is a deliberate, watched flip — never a silent swap.
