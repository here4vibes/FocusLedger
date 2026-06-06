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

module.exports = { extractTasks, detectCompletions };
