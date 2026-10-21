---
name: buddy-tool-use
description: Tool-use patterns for Buddy's agent (lib/agent-tools.js, routes/agent.js, lib/claude-client.js) — writing tool schemas, validating model input, the tool_result loop, multiple tool calls in one turn, tool_choice, errors and retries, confirm-tier actions and the truth rule. Use whenever you add or change a Buddy tool, touch the agent loop, add any AI call that should return structured data, or debug Buddy claiming something it didn't do.
---

<!--
NOTICE: Distilled from patterns in anthropics/claude-cookbooks at commit
a162e0184e71b60290808a43961a6cbc8060123c (MIT License, Copyright (c) 2023
Anthropic; full text in THIRD_PARTY_NOTICES.md at the repo root). Sources:
tool_use/customer_service_agent.ipynb, tool_use/parallel_tools.ipynb,
tool_use/tool_choice.ipynb, tool_use/extracting_structured_json.ipynb and
patterns/agents/. No notebook code was copied; the guidance is rewritten for
FocusLedger's files and CLAUDE.md rules.
-->

# Buddy Tool Use (FocusLedger)

## How Buddy's agent works today

- `lib/agent-tools.js` is the single source of truth: `TOOL_DEFS` (schemas the model sees), `TIERS` (`auto` runs now with Undo; `confirm` never auto-runs), `SCOPES` (`app` vs `world`), `dispatch()` and `reverse()`.
- `routes/agent.js` (`runAgentTurn`, plus the older `/act` copy of the same loop) makes **one** model call via `completeWithTools`, then runs every `tool_use` block. Auto-tier results become receipts with Undo; the first confirm-tier call becomes a confirmation card and stops the loop. Every action is written to the ledger with `logAction`.
- `lib/claude-client.js` is the only door to the API. `createMessage` reserves the per-user daily budget first (`lib/ai-budget.js` throws `AiQuotaError`, status 429) and records usage after. Never call the SDK directly.

Because the turn is single-shot, the model writes its reply text **before** any tool runs. That's why the system prompt has THE TRUTH RULE and why receipts, not the reply, are what the UI trusts. Keep it that way unless you deliberately add the loop below.

## 1. Writing a tool schema

- **Description says when and when not.** Name the user phrases that should trigger it and the cases that shouldn't ("don't call this when they're venting"). Over-eager tool calls are the common failure with `tool_choice: auto`; a precise description plus the system prompt fixes most of it.
- **Say where ids come from:** "Only use a task_id from the provided task list." The model invents ids otherwise.
- **Constrain with the schema:** `enum` for fixed choices (`recurrence`), explicit formats in the description (`YYYY-MM-DD`, `HH:MM` 24h), and `required` only for what the tool truly can't run without.
- **Keep types consistent across tools.** Today `task_id` is a `string` in `reschedule_task` / `mark_task_done` and an `integer` in `update_task`. Pick one for new tools (the DB id is an integer) and coerce in `dispatch`.
- **Encode honesty in the description** when the tool has a condition the user cares about (e.g. the push only fires with both `due_date` and `due_time`; "only promise what you set here").
- Add the tool to `TIERS` and `SCOPES` in the same change. An unknown name is skipped with a `console.warn`, so a missing tier silently does nothing.

## 2. Treat tool input as untrusted

Model output is user-controlled input by another route. In `dispatch`:

- Validate every field at the top of the case (regexes like `ISO_DATE`, `TIME_RE`, `EMAIL_RE`; enum membership; integer coercion) and return `{ ok: false, error }` for bad input. That's "fail at the boundary".
- Scope every query by `user_id = $userId`. Never trust a `task_id` alone.
- SQL stays parameterized. Today `agent-tools.js` runs `pool.query` inline; when you add queries, prefer a function in `db/` (CLAUDE.md: no raw SQL outside `db/`).
- Return an `undo` token only when `reverse()` can really restore the prior state; capture the previous value **before** the write.
- Expected failures come back as `{ ok: false, error }`; unexpected DB errors **throw** and the route logs them with the `[Agent]` prefix and records a `failed` ledger row. Never swallow (`__tests__/no-silent-catches.test.js` enforces it).
- Run the side effects the rest of the app runs: e.g. `mark_task_done` calls `onTasksCompleted` (routines), and `create_task` checks `findDuplicate` (`lib/task-dedupe.js`). A new completion or creation path must do the same.

## 3. Several tool calls in one response

The model may return more than one `tool_use` block in a single response (parallel tool use is on by default).

- **Writes run in order, one at a time**, as `runAgentTurn` does now. Two calls can touch the same task, and receipts should match the order the user asked.
- **Read-only tools** (if you add lookups) may run together with `Promise.all`, with each failure caught and logged on its own so one bad lookup doesn't sink the rest.
- **Confirm-tier stops the batch:** one confirmation card at a time. If you need the model to never mix a confirm call with others, pass `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`.
- The cookbook's "batch tool" meta-tool exists to coax older models into parallel calls. Don't add it here; Buddy's tools are writes that should run in order.

## 4. If you add a real tool loop

The cookbook's customer-service agent loops: call the model, run tools, send results back, repeat until `stop_reason !== 'tool_use'`. Adding it to `runAgentTurn` would let Buddy's reply reflect what actually happened. Rules if you do:

- Append the assistant's **full** `content` array (text and `tool_use` blocks) as the assistant message, then **one** user message holding a `tool_result` for **every** `tool_use` id from that response, in any order. A missing result is an API error.
- Failed tools return `{ type: 'tool_result', tool_use_id, content: out.error, is_error: true }` so the model can explain or ask, instead of claiming success.
- A confirm-tier call gets a result like "Waiting for the user to tap Send; nothing has been sent yet." so the model can't say it was sent.
- **Cap the iterations** (2–3 is plenty for Buddy). Each iteration is another `createMessage`, so it counts against the user's daily AI budget and adds latency.
- Keep the receipts the UI already shows; the final text is a nicer reply, not the source of truth.

## 5. tool_choice and structured output

- Buddy uses the default `auto`: the model may answer in plain text, which is right for coaching.
- `{ type: 'any' }` forces some tool; `{ type: 'tool', name }` forces one. A forced single tool whose `input_schema` is the shape you want is the most reliable way to get structured JSON from the model (classification, extraction, scores), more reliable than asking for JSON in text.
- `completeWithTools` doesn't pass `tool_choice` yet; add it as an optional param there (one place) rather than calling the SDK directly.
- For text replies that must be JSON, keep using `parseAiJson` from `lib/ai-json.js`. Never `JSON.parse` a raw model reply.

## 6. Errors, retries and stop reasons

- The Anthropic SDK already retries connection errors, 408/409/429 and 5xx with backoff (2 retries by default). Don't wrap calls in another retry loop; it multiplies cost and budget use.
- **Never retry `AiQuotaError`.** It's the user's daily limit. `quotaAwareResponses` only rewrites a **5xx** response into a 429 with `userMessage`, so a catch that answers 200 with "I couldn't think that through" hides the real reason. In a new catch, test `isQuotaError(err)` (`lib/ai-budget.js`) and show `err.userMessage`, or let the route answer 5xx.
- Check `resp.stop_reason`: `max_tokens` can cut a `tool_use` input short, so validate before dispatching (the regexes in section 2 catch most of it) and consider raising `maxTokens` for long drafts like emails; `refusal` means no tools ran, so return the text as-is.
- Log every AI failure with `[Agent]` (or the module's prefix), the operation and `userId`, as the existing `turn AI error` line does. Sentry picks up every `console.error`.

## 7. Prompt rules that go with the tools

- THE TRUTH RULE stays in every Buddy system prompt that has tools: only claim what a tool receipt confirms.
- Give the model the ids it may use (the open-tasks list) and today's date in the **user's** timezone (`getUserLocalDate(tz)`), never the server clock.
- Don't let it state company phone numbers, URLs or menu paths from memory; cancel links come from `lib/cancel-links.js`.

## 8. Testing a tool change

- Unit-test `dispatch` cases with a mocked `pool` (see the patterns in `__tests__/`), including bad input and "task not found".
- Mock `lib/claude-client.js` to return canned `content` arrays (text plus one or more `tool_use` blocks) to test the route loop without spending tokens.
- `npx jest` must pass; the silent-catch and inline-script tests run with it.
