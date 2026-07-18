# Cowork Stage 1 — "Buddy does it" (draft-and-do-in-app)

Status: **draft spec, pre-implementation.** Owner: Sean. Surface: weightless (`/weightless`) first.

## Why this exists

Free FocusLedger *tells you* what to do. The paid promise (Lane ② — "Money/Life Autopilot") is that **Buddy does the thing you've been avoiding.** For an ADHD user the avoided admin task *is* the ADHD tax, so execution — not tracking — is what people will pay for.

Stage 1 is the smallest version that is genuinely "acting on your behalf" without external browser automation. It establishes the reusable machinery — a tool-using agent, a risk-tiered confirmation gate, and a logged, reversible action ledger — and ships one flagship outward action (send the email you keep avoiding).

Out of scope for Stage 1: driving third-party websites (subscription cancellation, form-filling, chargebacks). That's Stage 3 and needs a browser agent + credential vault + liability review.

## Principles

1. **Risk-tiered autonomy.** Two tiers, decided per action type, never per-message by the model:
   - `auto` — in-app and reversible (reschedule a task, break it into steps, triage an expense). Execute immediately, show a receipt with **Undo**.
   - `confirm` — outward-facing, financial, or irreversible (send an email, delete something, spend money). **Never** auto-execute. Summon a confirmation card; the user taps to proceed.
   The model may *propose* any allow-listed action; the tier (not the model) decides whether it runs without a human tap.
2. **Log everything, reverse where possible.** Every proposed/executed/undone action is a row in `agent_actions` with its params, result, and an undo token. This is "no silent failures" applied to *actions*: trust needs an audit trail and an undo.
3. **The model cannot invent capabilities.** It can only call tools in a fixed allow-list. No free-form shell, no arbitrary HTTP.
4. **Confirmation is a receipt, not a wall.** The confirm card shows *exactly* what will happen (full email text, recipient) and is editable inline — it's the summoned-surface pattern, not a modal interruption.
5. **Gating is honest.** Execution is the paid tier's value. Free users see Buddy *draft* and hit the demonstrate-then-name upsell at the Send button (see Monetization).

## Stage 1 action catalog

| Action | Tier | Reversible? | Mechanism | Exists today? |
|---|---|---|---|---|
| `reschedule_task` | auto | yes (restore prev due date) | `UPDATE tasks` | task routes exist |
| `break_task_into_steps` | auto | yes (delete created steps) | `INSERT task_steps` / substeps | AI split exists |
| `triage_expense` | auto | yes (restore prev is_impulse) | `PATCH /api/expenses/:id/triage` | exists |
| `snooze_task` / `mark_done` | auto | yes | `UPDATE tasks` | exists (conversation auto-complete) |
| `create_routine_from_tasks` | auto | yes (delete routine) | routine routes | exists |
| `draft_and_send_email` | **confirm** | partial (CC self; "unsend" window) | see §Email | **new** |

Prove the loop on the `auto` in-app actions first (zero external risk, fully reversible), then layer the one `confirm` action — email — as the flagship.

## Architecture: a tool-use loop with a gate

```
POST /api/agent/act  { message }
        │
        ▼
Claude (tools = allow-list)  ──► stop_reason?
        │                          ├─ "end_turn"  → return { reply }             (just talking)
        │                          └─ "tool_use"  → for each proposed tool:
        │                                              tier=auto    → dispatch → log(executed) → tool_result → loop
        │                                              tier=confirm → log(proposed) → return confirmation card, STOP
        ▼
POST /api/agent/confirm  { action_id }   → dispatch → log(executed) → return receipt   (idempotent by action_id)
POST /api/agent/undo     { action_id }   → run reverser → log(undone) → return receipt
```

### New/changed code

- `lib/claude-client.js` — add `completeWithTools({ system, messages, tools, model, maxTokens })` returning the **full** response (`stop_reason` + content blocks), so the caller can read `tool_use` blocks. `complete()` stays as-is.
- `lib/agent-tools.js` **(new)** — the single source of truth:
  - `TOOL_DEFS` — Anthropic tool schemas (name, description, input_schema) for the allow-list.
  - `TIERS` — `{ toolName: 'auto' | 'confirm' }`.
  - `dispatch(pool, userId, name, input)` → `{ ok, result, receipt, undo }`. Throws on unexpected error (logged by caller).
  - `reverse(pool, userId, actionRow)` → undoes an executed action from its `undo` token.
- `routes/agent.js` **(new)** — `POST /act`, `POST /confirm`, `POST /undo`; `authenticateToken`; owns the loop above. Mounted in `server.js` under `/api/agent`.
- `db/agent-actions.js` **(new)** — `logAction`, `getAction`, `markExecuted`, `markUndone`, `recentActionCount` (for rate limits). All SQL lives here (no raw SQL in routes).
- `migrations/<ts>_create_agent_actions.js` **(new)** — table below.
- `public/weightless.html` — render the **confirmation card** and **receipt/undo** note; wire `/api/agent/*`. Money-intent already intercepts; add an "action-intent" path that calls `/api/agent/act`.

### Data model — `agent_actions`

```
id             SERIAL PRIMARY KEY
user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
action_type    TEXT    NOT NULL
status         TEXT    NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','confirmed','executed','failed','undone','cancelled'))
risk_tier      TEXT    NOT NULL CHECK (risk_tier IN ('auto','confirm'))
params         JSONB   NOT NULL DEFAULT '{}'::jsonb   -- the tool input
result         JSONB                                   -- execution result / external ids
undo_token     JSONB                                   -- how to reverse (e.g. {task_id, prev_due_date})
error          TEXT
source         TEXT    NOT NULL DEFAULT 'weightless'
created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
executed_at    TIMESTAMPTZ
undone_at      TIMESTAMPTZ
```
Indexes: `(user_id, created_at DESC)`, `(status)`. Migration ships with a matching genesis entry so fresh DBs and prod stay reproducible (per the durability work).

### Confirmation-card contract (server → client)

```json
{ "type": "confirmation",
  "action": { "id": 42, "action_type": "draft_and_send_email",
              "title": "Send this to your landlord?",
              "preview": { "to": "landlord@…", "subject": "…", "body": "…" },
              "editable": ["subject","body"],
              "confirmLabel": "Send it", "cancelLabel": "Not yet" } }
```
Receipt (after `auto` execute or `confirm`). `scope` labels whether anything
left FocusLedger — `app` renders "App only", `world` renders "Real world" — so
an in-app change is never confused with a real-world side effect:
```json
{ "type": "receipt",
  "action": { "id": 42, "summary": "Sent to your landlord ✓", "scope": "world", "undoable": false } }
```

## The email decision (§Email)

`gmail.send` is a Google **restricted** scope (security assessment required for production) — so "send from your Gmail" is **not** a Stage-1 path. Three options:

- **(a) Gmail send scope** — truest "as you", but restricted-scope review = weeks/compliance. Deferred.
- **(b) Send via Resend, reply-to you** — from `Sean Hendler (via FocusLedger) <errands@focusledger.net>`, `reply-to:` your real address, `cc:` you (so you keep a copy and get replies). Already wired, deliverable, honest. **Recommended for Stage 1.**
- **(c) Draft + one-tap handoff** — generate the email, deep-link to a Gmail compose / `mailto:`; you tap send in your own client. Zero send-risk, zero new scope, but FL isn't the one executing.

Recommendation: **(b)** as the real "on your behalf", with **(c)** available as a per-user fallback ("open in my mail app instead"). Guardrails: recipient shown and confirmed in the card; user always CC'd; hard cap N sends/day/user; transactional (no bulk); body/subject rendered verbatim before send.

## Safety & guardrails

- Allow-list only; unknown tool names are rejected and logged.
- `confirm`-tier actions never execute without a `POST /confirm` carrying the `action_id`; `/confirm` is idempotent (status guard) so a double-tap can't double-send.
- Email: only to addresses surfaced in the confirmation card; rate-limited; user CC'd; content shown verbatim.
- Every dispatch wrapped so failures write `status='failed'` + `error` (context-rich) — never a silent catch.
- Undo available on every `auto` action and (as CC + unsend window) on email.
- QA user (`qa@focusledger.net`) excluded from any outward send in non-prod.

## Monetization

Execution is Lane ② value. Proposed split:
- **Free:** `auto` in-app actions (reschedule, steps, triage) work — they're just faster editing of your own data. Buddy will also *draft* an email, but the **Send** button triggers demonstrate-then-name: "Sending it for you is an Autopilot thing — here's the draft, want me to handle it?"
- **Paid (Autopilot):** `draft_and_send_email` and all future outward/Stage-2/3 execution.

(Decision needed — see below.)

## Testing

- **Unit** (`__tests__/agent-tools.test.js`): each tool's dispatch (mock pool) + reverser round-trips; `confirm`-tier never executes inside `/act`; unknown tool rejected.
- **Gate test:** `/act` returning a `confirm` proposal does **not** write an executed row; `/confirm` does, and is idempotent.
- **No-silent-failure test:** a throwing dispatch writes `status='failed'` with error.
- **Boot-smoke extension:** migration runs from scratch; `/api/agent/act` with a stubbed tool_use proposes; `/confirm` executes against a mocked email sender.

## Rollout order

1. Migration + `db/agent-actions.js` + genesis entry.
2. `completeWithTools` + `lib/agent-tools.js` with the two safest `auto` tools (`reschedule_task`, `break_task_into_steps`).
3. `routes/agent.js` `/act` + `/undo`; weightless receipt + undo rendering. **Ship — prove the loop, zero external risk.**
4. Add `draft_and_send_email` (`confirm`) + `/confirm` + confirmation card + email option (b). Behind the paid gate. **Ship the flagship.**
5. Expand the `auto` catalog; consider Stage 2 (connected-account actions) once trust + logs look good.

## Open decisions (need Sean)

1. **Email mechanism:** (b) Resend reply-to [rec] · (c) draft+handoff · (a) Gmail send scope [heavy].
2. **Autonomy default:** confirm all of `auto`, or let reschedule/steps/triage run silently with Undo [rec]?
3. **Gating:** outward execution paid-only, in-app `auto` free [rec] — or all execution paid?
4. **Undo window for email:** CC-only, or add a real 30–60s "unsend" hold before Resend fires [rec]?
