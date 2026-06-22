'use strict';

const { complete } = require('./claude-client');

/**
 * Send a chat completion request.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ maxTokens?: number, system?: string, model?: string }} options
 * @returns {Promise<string>} AI reply text
 */
async function chatMessages(messages, { maxTokens = 500, system, model } = {}) {
  // Anthropic SDK requires `system` as a top-level param, not a message with role:'system'.
  // Some callers (buddy.js) embed it inline using the OpenAI convention — extract it here.
  let systemPrompt = system;
  const chatMsgs = messages.filter(m => {
    if (m.role === 'system') {
      systemPrompt = systemPrompt || m.content;
      return false;
    }
    return true;
  });
  return complete({ system: systemPrompt, messages: chatMsgs, maxTokens, model });
}

module.exports = { chatMessages };
