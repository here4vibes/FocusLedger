'use strict';

const Anthropic = require('@anthropic-ai/sdk');

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Simple text completion. Returns the raw response text.
 * @param {{ system?: string, messages: Array<{role, content}>, model?: string, maxTokens?: number }} opts
 * @returns {Promise<string>}
 */
async function complete({ system, messages, model = 'claude-haiku-4-5', maxTokens = 500 }) {
  const params = { model, max_tokens: maxTokens, messages };
  if (system) params.system = system;
  const resp = await getClient().messages.create(params);
  return resp.content[0].text.trim();
}

module.exports = { getClient, complete };
