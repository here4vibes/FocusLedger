'use strict';
/**
 * lib/emailService.js — Thin wrapper around the Resend SDK.
 * All transactional emails go through this module so we have one place
 * to handle logging, signatures, and test mocking.
 *
 * WHY dual signature: every caller in the codebase uses
 * `sendEmail(pool, { to, subject, html, templateType, userId })`, but this
 * module previously exported `sendEmail({ to, subject, html })` — so the pool
 * was destructured as the options object and Resend was called with
 * to: undefined. EVERY transactional email (welcome, password reset,
 * re-engagement, weekly nudges, follow-ups) silently failed. Both signatures
 * are now accepted.
 *
 * Contract: NEVER throws. Returns { success, id?, error? }. When a pool is
 * provided, the attempt is recorded in email_log (best-effort).
 */

const { Resend } = require('resend');

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

// Best-effort audit log — never lets a logging failure break a send path.
function logEmail(pool, { userId, templateType, to, subject, resendId, success, error }) {
  if (!pool || typeof pool.query !== 'function') return;
  pool.query(
    `INSERT INTO email_log (user_id, template_type, to_email, subject, resend_id, success, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId || null, templateType || null, Array.isArray(to) ? to[0] : to,
     subject || null, resendId || null, success, error || null]
  ).catch(e => console.warn('[email] email_log insert failed:', e.message));
}

/**
 * Send a transactional email.
 * Accepts (opts) or (pool, opts) — see module header.
 * @returns {Promise<{ success: boolean, id?: string, error?: string }>}
 */
async function sendEmail(poolOrOpts, maybeOpts) {
  const hasPool = poolOrOpts && typeof poolOrOpts.query === 'function';
  const pool = hasPool ? poolOrOpts : null;
  const opts = (hasPool ? maybeOpts : poolOrOpts) || {};
  const { to, from, subject, html, text, templateType, userId } = opts;

  try {
    if (!to || !subject || !html) {
      throw new Error(`missing required field (to=${!!to}, subject=${!!subject}, html=${!!html})`);
    }
    const resend = getResend();
    const result = await resend.emails.send({
      from: from || 'FocusLedger <hello@focusledger.net>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {}),
    });
    // Resend SDK v3+ resolves with { data, error } instead of rejecting
    if (result && result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const id = result?.data?.id || result?.id || null;
    logEmail(pool, { userId, templateType, to, subject, resendId: id, success: true });
    return { success: true, id };
  } catch (e) {
    console.error('[email] send failed:', e.message,
      '| to:', Array.isArray(to) ? to[0] : to, '| template:', templateType || 'n/a');
    logEmail(pool, { userId, templateType, to, subject, success: false, error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = { sendEmail };
