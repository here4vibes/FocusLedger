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

/**
 * Tool-enabled completion. Returns the FULL response (stop_reason + content
 * blocks) so the caller can read `tool_use` blocks and run the agent loop.
 * See docs/cowork-stage1-spec.md.
 * @param {{ system?: string, messages: Array, tools: Array, model?: string, maxTokens?: number }} opts
 * @returns {Promise<object>} raw Anthropic Messages response
 */
async function completeWithTools({ system, messages, tools, model = 'claude-haiku-4-5', maxTokens = 1024 }) {
  const params = { model, max_tokens: maxTokens, messages, tools };
  if (system) params.system = system;
  return getClient().messages.create(params);
}

module.exports = { getClient, complete, completeWithTools };
