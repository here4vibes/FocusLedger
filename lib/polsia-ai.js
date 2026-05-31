'use strict';

const OpenAI = require('openai');

let _client;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Send a chat completion request.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ maxTokens?: number, system?: string }} options
 * @returns {Promise<string>} AI reply text
 */
async function chatMessages(messages, { maxTokens = 500, system } = {}) {
  const client = getClient();
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: msgs,
    max_tokens: maxTokens,
  });
  return resp.choices[0].message.content.trim();
}

module.exports = { chatMessages };
