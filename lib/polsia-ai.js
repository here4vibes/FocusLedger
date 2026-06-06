'use strict';

const { complete } = require('./claude-client');

/**
 * Send a chat completion request.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ maxTokens?: number, system?: string }} options
 * @returns {Promise<string>} AI reply text
 */
async function chatMessages(messages, { maxTokens = 500, system } = {}) {
  return complete({ system, messages, maxTokens });
}

module.exports = { chatMessages };
