'use strict';
/**
 * routes/email-to-tasks.js — Email-to-tasks inbound processing + magic link claim.
 *
 * Owns: Processing emails sent to tasks@focusledger.net, linked_emails management,
 *       magic link claim flow (/link-email?token=...).
 *
 * Does NOT own: general inbound email storage (routes/inbound-email.js),
 *               user auth (middleware/auth.js), task CRUD (routes/tasks.js).
 */

const express = require('express');
const crypto  = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus }    = require('../middleware/proUtils');
const {
  findUserByEmail,
  addLinkedEmail,
  listLinkedEmails,
  removeLinkedEmail,
  stashEmail,
  findStashByToken,
  claimStash,
  purgeExpiredStash,
  insertEmailTask,
  isMessageDuplicate,
} = require('../db/email-to-tasks');

// Polsia email proxy used for sending replies
// WHY: app already uses Resend directly for outbound; however the email proxy
//      skill says to use it for sends. We use the proxy for email-to-tasks replies
//      since this is new code and the proxy is the approved pattern.
const PROXY_BASE = 'https://polsia.com/api/proxy/email';
const APP_BASE_URL = process.env.APP_URL || 'https://focusledger.polsia.app';

/**
 * Send an email via the Polsia email proxy.
 * reply_to_email_id bypasses rate limits for replies to inbound emails.
 */
async function sendProxyEmail({ to, subject, body, html, reply_to_email_id }) {
  const apiKey = process.env.POLSIA_API_KEY;
  if (!apiKey) {
    console.error('[email-to-tasks] POLSIA_API_KEY not set — cannot send reply');
    return;
  }
  const payload = { to, subject, body };
  if (html)              payload.html = html;
  if (reply_to_email_id) payload.reply_to_email_id = reply_to_email_id;

  try {
    const res = await fetch(`${PROXY_BASE}/send`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[email-to-tasks] Proxy send failed ${res.status}: ${err}`);
    }
  } catch (err) {
    console.error('[email-to-tasks] Proxy send error:', err.message);
  }
}

/**
 * Determine if a user row (from findUserByEmail) has an active Autopilot subscription.
 * WHY: findUserByEmail joins app_subscription; we centralise the check here so we
 *      don't duplicate subscription logic outside of proUtils.
 */
function userIsPro(row) {
  if (!row) return false;
  if (row.admin_pro_override) {
    if (!row.pro_granted_until || new Date(row.pro_granted_until) > new Date()) return true;
  }
  return !!(row.plan === 'pro' && row.sub_status === 'active');
}

/**
 * Build a task title from an email subject.
 * Empty subject → use first 80 chars of body.
 * Strips Re:/Fwd: prefixes (task is the action, not the chain).
 */
function buildTaskTitle(subject, bodyText) {
  const cleaned = (subject || '')
    .replace(/^(re|fwd?|fw):\s*/gi, '')
    .trim();
  if (cleaned) return cleaned.slice(0, 150);
  const bodySnippet = (bodyText || '').trim().slice(0, 80);
  return bodySnippet || 'Email task (no subject)';
}

/**
 * Strip quoted email reply chains from body text.
 * WHY: Re-replies include the full thread; only the latest message is the task.
 * Simple heuristic: cut at first line starting with ">" or "On ... wrote:".
 */
function stripQuotedText(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const cutIdx = lines.findIndex(
    l => l.startsWith('>') || /^On .+ wrote:/i.test(l.trim())
  );
  const relevant = cutIdx > 0 ? lines.slice(0, cutIdx) : lines;
  return relevant.join('\n').trim();
}

/**
 * Auto-reply HTML template.
 */
function replyHtml(heading, body, ctaText, ctaUrl) {
  const ctaBlock = ctaText && ctaUrl
    ? `<div style="text-align:center;margin:28px 0;">
         <a href="${ctaUrl}" style="display:inline-block;background:#4F46E5;color:#fff;
            text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;
            font-weight:600;">${ctaText}</a>
       </div>`
    : '';
  return `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#2D2A26;padding:24px;">
      <div style="margin-bottom:20px;">
        <span style="font-size:22px;font-weight:700;color:#4F46E5;">FocusLedger</span>
      </div>
      <h2 style="font-size:18px;margin-top:0;">${heading}</h2>
      <p style="font-size:15px;line-height:1.6;color:#3D3A36;">${body}</p>
      ${ctaBlock}
      <hr style="border:none;border-top:1px solid #E8E5E0;margin:24px 0;" />
      <p style="font-size:12px;color:#9E9A96;">FocusLedger · ADHD-native command center</p>
    </div>
  `;
}

// =============================================================================
// Core handler — called from inbound-email webhook when to=tasks@focusledger.net
// =============================================================================

/**
 * Process an inbound email to tasks@focusledger.net.
 * Called from routes/inbound-email.js webhook handler (fire-and-forget).
 *
 * @param {object} pool
 * @param {object} emailData  — { fromEmail, subject, bodyText, bodyHtml, messageId, emailId }
 */
async function processEmailToTask(pool, emailData) {
  const { fromEmail, subject, bodyText, bodyHtml, messageId, emailId } = emailData;

  console.log(`[email-to-tasks] Processing email from=${fromEmail} subject="${subject}"`);

  // Dedup by message-id to handle re-delivered webhooks
  if (messageId && await isMessageDuplicate(pool, messageId)) {
    console.log(`[email-to-tasks] Duplicate message_id=${messageId} — skipped`);
    return;
  }

  // Look up sender
  const userRow = await findUserByEmail(pool, fromEmail);

  if (userRow) {
    // Known sender — check Autopilot status
    if (!userIsPro(userRow)) {
      // Free user — reject cleanly
      await sendProxyEmail({
        to: fromEmail,
        subject: 'Email-to-Tasks is an Autopilot feature',
        body: `Thanks for emailing! Creating tasks by email is available on the Autopilot plan ($9.99/mo). Upgrade at ${APP_BASE_URL}/app/settings to unlock this and more. Your email was not saved — forward it again after upgrading.`,
        html: replyHtml(
          'Email-to-Tasks is an Autopilot feature',
          `Thanks for emailing! Creating tasks by email is available on the Autopilot plan ($9.99/mo).<br><br>Your email was <strong>not saved</strong> — forward it again after upgrading.`,
          'Upgrade to Autopilot',
          `${APP_BASE_URL}/app/settings`
        ),
        reply_to_email_id: emailId,
      });
      console.log(`[email-to-tasks] Free user ${fromEmail} — rejected with upgrade nudge`);
      return;
    }

    // Paid user — create task
    const title = buildTaskTitle(subject, bodyText);
    const notes = stripQuotedText(bodyText);
    const task  = await insertEmailTask(pool, { userId: userRow.id, title, notes });
    const taskUrl = `${APP_BASE_URL}/app`;

    await sendProxyEmail({
      to: fromEmail,
      subject: `✅ Task created: ${title}`,
      body: `Your email has been added as a task in FocusLedger.\n\nTask: ${title}\n\nView your tasks: ${taskUrl}`,
      html: replyHtml(
        `✅ Task created`,
        `Your email has been added as a task in FocusLedger.<br><br><strong>${title}</strong>`,
        'View Tasks',
        taskUrl
      ),
      reply_to_email_id: emailId,
    });
    console.log(`[email-to-tasks] ✓ Task ${task.id} created for user=${userRow.id} from email`);

  } else {
    // Unknown sender — stash + magic link
    const token = crypto.randomBytes(24).toString('hex');
    await stashEmail(pool, { fromEmail, subject, bodyText, bodyHtml, messageId, token });

    const magicLink = `${APP_BASE_URL}/link-email?token=${token}`;

    await sendProxyEmail({
      to: fromEmail,
      subject: 'Almost there — connect this email to FocusLedger',
      body: `We got your email but don't recognize this address yet. Click below to link it to your account — your task will be created automatically.\n\n${magicLink}\n\nThis is a one-time step. Future emails from this address will create tasks instantly.`,
      html: replyHtml(
        'Almost there — connect this email to FocusLedger',
        `We got your email but don't recognize this address yet.<br><br>Click below to link it to your account — your task will be created automatically.<br><br>This is a one-time step. Future emails from this address will create tasks instantly.`,
        'Connect & Create Task',
        magicLink
      ),
      reply_to_email_id: emailId,
    });
    console.log(`[email-to-tasks] Unknown sender ${fromEmail} — stashed + magic link sent`);
  }
}

// =============================================================================
// Express router — authenticated endpoints for link-email flow
// =============================================================================

const routerFactory = function(pool) {
  const router = express.Router();

  /**
   * GET /api/email-to-tasks/claim?token=...
   * Called after user logs in via /link-email page.
   * Requires auth — the login IS the verification.
   */
  router.get('/claim', authenticateToken, async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token required' });

    try {
      const userId = req.user.id;

      // Check Autopilot status before doing anything
      let isPro;
      try {
        isPro = await checkProStatus(pool, userId);
      } catch (err) {
        console.error('[email-to-tasks] Pro check error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to verify subscription' });
      }

      const stash = await findStashByToken(pool, token);
      if (!stash) {
        return res.status(404).json({
          success: false,
          message: 'Link expired or already used. Please email tasks@focusledger.net again.',
        });
      }

      if (!isPro) {
        // Free user clicked magic link — don't link or create task
        return res.status(403).json({
          success: false,
          code:    'PRO_REQUIRED',
          message: 'Email-to-Tasks is available on Autopilot. Upgrade in Settings to use this feature.',
        });
      }

      // Add the sender email as a linked address (login = verification)
      const linkResult = await addLinkedEmail(pool, userId, stash.from_email);
      if (!linkResult.added && linkResult.reason === 'max_linked_emails') {
        return res.status(422).json({
          success: false,
          message: 'You have reached the maximum of 5 linked email addresses.',
        });
      }

      // Create the task from the stashed email
      const title = buildTaskTitle(stash.subject, stash.body_text);
      const notes = stripQuotedText(stash.body_text);
      const task  = await insertEmailTask(pool, { userId, title, notes });

      // Mark stash as claimed
      await claimStash(pool, token);

      console.log(`[email-to-tasks] ✓ Magic link claimed: user=${userId} email=${stash.from_email} task=${task.id}`);

      res.json({
        success: true,
        message: `Email linked + task created: ${title}`,
        task: { id: task.id, title: task.title },
        linked_email: stash.from_email,
      });
    } catch (err) {
      console.error('[email-to-tasks] Claim error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to process magic link' });
    }
  });

  /**
   * GET /api/email-to-tasks/linked — list user's linked emails.
   */
  router.get('/linked', authenticateToken, async (req, res) => {
    try {
      const emails = await listLinkedEmails(pool, req.user.id);
      res.json({ success: true, linked_emails: emails });
    } catch (err) {
      console.error('[email-to-tasks] List linked error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to list linked emails' });
    }
  });

  /**
   * DELETE /api/email-to-tasks/linked/:id — unlink an email address.
   */
  router.delete('/linked/:id', authenticateToken, async (req, res) => {
    try {
      await removeLinkedEmail(pool, req.params.id, req.user.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[email-to-tasks] Unlink error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to unlink email' });
    }
  });

  /**
   * POST /api/email-to-tasks/cleanup — admin cron to purge expired stash entries.
   * WHY: cleanup runs server-side on a schedule; this endpoint exists for manual trigger in dev.
   */
  router.post('/cleanup', authenticateToken, async (req, res) => {
    try {
      const count = await purgeExpiredStash(pool);
      res.json({ success: true, deleted: count });
    } catch (err) {
      console.error('[email-to-tasks] Cleanup error:', err.message);
      res.status(500).json({ success: false, message: 'Cleanup failed' });
    }
  });

  return router;
};

// Named export so routes/inbound-email.js can call processEmailToTask directly.
routerFactory.processEmailToTask = processEmailToTask;
module.exports = routerFactory;
