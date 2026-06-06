'use strict';

const { complete } = require('./claude-client');

async function summarizeText(text, maxLength = 200) {
  return complete({
    messages: [{ role: 'user', content: `Summarize the following in ${maxLength} characters or fewer:\n\n${text}` }],
    maxTokens: Math.ceil(maxLength / 3),
  });
}

async function suggestTaskFromText(text, values = []) {
  const valueList = values.map(v => `${v.id}: ${v.value_name}`).join('\n');
  const prompt = `Extract actionable tasks from the text below. Return ONLY valid JSON: {"tasks": [{"title": "...", "value_id": null, "value_name": null, "priority": "medium"}]}.\n\nUser values:\n${valueList || '(none)'}\n\nText:\n${text}`;
  try {
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 500 });
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    return Array.isArray(parsed) ? parsed : (parsed.tasks || []);
  } catch {
    return [];
  }
}

function parseAIResponse(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

module.exports = { summarizeText, suggestTaskFromText, parseAIResponse };
