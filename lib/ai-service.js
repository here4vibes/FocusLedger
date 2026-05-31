'use strict';

const OpenAI = require('openai');

let _client;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

async function summarizeText(text, maxLength = 200) {
  const resp = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Summarize the following in ${maxLength} characters or fewer:\n\n${text}`,
    }],
    max_tokens: Math.ceil(maxLength / 3),
  });
  return resp.choices[0].message.content.trim();
}

async function suggestTaskFromText(text, values = []) {
  const valueList = values.map(v => `${v.id}: ${v.value_name}`).join('\n');
  const prompt = `Extract actionable tasks from the text below. Return JSON: {"tasks": [{"title": "...", "value_id": null, "value_name": null, "priority": "medium"}]}.\n\nUser values:\n${valueList || '(none)'}\n\nText:\n${text}`;
  try {
    const resp = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
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
