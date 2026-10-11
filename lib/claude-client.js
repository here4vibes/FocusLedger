'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiBudget = require('./ai-budget');

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
  const resp = await createMessage(params);
  return resp.content[0].text.trim();
}

/**
 * Every AI call goes through here: counts it against the current user's daily
 * budget first (lib/ai-budget.js; throws AiQuotaError when over), then records
 * the tokens used. Outside a user request (cron jobs) it's just the API call.
 * @param {object} params Anthropic messages.create params
 */
async function createMessage(params) {
  const handle = await aiBudget.reserve();
  const resp = await getClient().messages.create(params);
  aiBudget.recordUsage(handle, resp && resp.usage);
  return resp;
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
  return createMessage(params);
}

module.exports = { getClient, complete, completeWithTools, createMessage };
