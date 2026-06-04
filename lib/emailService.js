'use strict';
/**
 * lib/emailService.js — Thin wrapper around the Resend SDK.
 * All transactional emails go through this module so we have one place
 * to handle retries, logging, and test mocking.
 */

const { Resend } = require('resend');

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Send a transactional email.
 * @param {{ to: string|string[], from?: string, subject: string, html: string, text?: string }} opts
 * @returns {Promise<{ id: string }>}
 */
async function sendEmail({ to, from, subject, html, text }) {
  const resend = getResend();
  const result = await resend.emails.send({
    from: from || 'FocusLedger <hello@focusledger.net>',
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text ? { text } : {}),
  });
  return result;
}

module.exports = { sendEmail };
