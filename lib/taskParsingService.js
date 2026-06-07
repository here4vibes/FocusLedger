'use strict';

const { complete } = require('./claude-client');

/**
 * Extract actionable tasks from free-form text using AI.
 * @returns {Promise<Array<{title, value_id, value_name, priority}>>}
 */
async function extractTasks(text, userValues = []) {
  if (!text.trim()) return [];
  const valueList = userValues.map(v => `${v.id}: ${v.value_name}`).join('\n');
  const prompt = `Extract actionable tasks from this text. Return ONLY valid JSON: {"tasks": [{"title": "short task title", "value_id": null, "value_name": null, "priority": "medium"}]}.
Match value_id and value_name from:
${valueList || '(none)'}

Text:
${text}`;
  try {
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 600 });
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    return Array.isArray(parsed) ? parsed : (parsed.tasks || []);
  } catch {
    return [];
  }
}

/**
 * Detect which active tasks the user is reporting as completed.
 * @param {string} text
 * @param {Array<{id, title}>} activeTasks
 * @returns {Promise<Array<{match_type, task_id, matched_phrase}>>}
 */
async function detectCompletions(text, activeTasks = []) {
  if (!activeTasks.length || !text.trim()) return [];
  const taskList = activeTasks.slice(0, 20).map(t => `${t.id}: ${t.title}`).join('\n');
  const prompt = `Does this message indicate any of these tasks were completed?
Tasks:
${taskList}

Message: "${text}"

Return ONLY valid JSON: {"matches": [{"match_type": "complete", "task_id": <number>, "matched_phrase": "<phrase>"}]}
Return empty matches array if nothing was completed.`;
  try {
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 300 });
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    return parsed.matches || [];
  } catch {
    return [];
  }
}

/**
 * Passively scan a single Buddy message for new tasks and expense mentions.
 * Non-blocking — called in parallel with detectCompletions during conversation turns.
 * Returns items for the user to confirm; nothing is auto-saved.
 * @returns {Promise<{tasks: Array<{title, due_date}>, expenses: Array<{amount, description, category}>}>}
 */
async function extractPassiveCapture(text) {
  if (!text || text.trim().length < 8) return { tasks: [], expenses: [] };
  const prompt = `Scan this message for two things only:

1. Tasks the person intends to do in the future (NOT things already done or completed)
2. Money spent — only if an explicit dollar amount is mentioned with context

Message: "${text}"

Return ONLY valid JSON:
{
  "tasks": [{"title": "Verb-first title under 60 chars", "due_date": null}],
  "expenses": [{"amount": 47.50, "description": "short what/where", "category": "other"}]
}

Task categories: groceries, food_delivery, transport, health, shopping, bills, subscriptions, housing, fun, other
Return empty arrays if nothing qualifies. Never include past-tense actions.`;
  try {
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 300 });
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 3) : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses.slice(0, 3) : [],
    };
  } catch {
    return { tasks: [], expenses: [] };
  }
}

/**
 * Detect whether a Buddy message looks like a brain dump.
 * Fires on explicit keywords, or long multi-item messages on early turns.
 */
function isBrainDump(text, userTurn = 99) {
  if (!text || text.trim().length < 20) return false;
  const DUMP_KEYWORDS = /brain\s*dump|overwhelm(?:ed)?|dump|offload|everything on my mind|running through my head|all the things|here'?s? (?:what|everything)/i;
  if (DUMP_KEYWORDS.test(text)) return true;
  // Only auto-detect on turns 1–3 to avoid triggering mid-conversation
  if (userTurn > 3) return false;
  const wordCount = text.trim().split(/\s+/).length;
  const hasListSignals = /[,;]|\band\b.*\band\b.*\band\b|\n|(?:also|plus|oh and|don'?t forget)/i.test(text);
  return wordCount >= 20 && hasListSignals;
}

/**
 * Parse a brain dump message into triaged task groups.
 * Returns { tasks: [{title, category, priority}], summary }
 * category: 'do_today' | 'do_soon' | 'parked'
 */
async function extractBrainDump(text, userValues = []) {
  const valueList = userValues.map(v => `${v.id}: ${v.value_name}`).join('\n');
  const prompt = `You are an ADHD coaching assistant. Parse this brain dump into tasks.

Classify each item as:
- "do_today": urgent, has a deadline, or the person seems anxious about it
- "do_soon": important but not time-pressured
- "parked": vague idea, worry, or not immediately actionable (still capture it)

Values to match (use value_id/value_name if relevant):
${valueList || '(none)'}

Brain dump:
"${text}"

Return ONLY valid JSON (max 10 tasks):
{
  "tasks": [
    {"title": "Verb-first action under 60 chars", "category": "do_today", "priority": "high", "value_id": null, "value_name": null}
  ],
  "summary": "one sentence summarizing what was captured"
}`;

  try {
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 800 });
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 10) : [],
      summary: parsed.summary || 'Got your brain dump.',
    };
  } catch {
    return { tasks: [], summary: 'Got your brain dump.' };
  }
}

module.exports = { extractTasks, detectCompletions, extractPassiveCapture, isBrainDump, extractBrainDump };
