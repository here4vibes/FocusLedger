'use strict';
/**
 * routes/inbound-email.js — Inbound email webhook + admin two-way inbox API.
 *
 * Owns: POST /api/webhooks/resend-inbound (Resend inbound webhook)
 *       GET/POST /api/inbox/* (admin inbox CRUD + reply)
 *
 * Does NOT own: outbound marketing emails (emailService.js / email_log),
 *               user authentication (auth middleware),
 *               email-to-tasks logic (routes/email-to-tasks.js)
 */

const express = require('express');
const router = express.Router();
const { Resend } = require('resend');
const { authenticateToken } = require('../middleware/auth');
const { queryWithRetry } = require('../lib/queryWithRetry');
const {
  insertInboundEmail,
  insertOutboundEmail,
  listThreads,
  getThread,
  markThreadRead,
  countUnread,
} = require('../db/customer-emails');
const { processEmailToTask } = require('./email-to-tasks');

// WHY: emails to tasks@focusledger.net trigger task creation, not inbox storage.
// All other inbound emails go to the admin inbox as before.
const TASKS_ADDRESS_PATTERN = /tasks@focusledger\.net/i;

const FROM_ADDRESS = process.env.EMAIL_FROM || 'FocusLedger <hello@focusledger.net>';
// Notification recipient for inbound email forwarding
const FORWARD_TO = 'sean.hendler@gmail.com';

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[inbound-email] RESEND_API_KEY not set');
    return null;
  }
  return new Resend(apiKey);
}

/**
 * Derive a thread_id from the email chain.
 * Uses In-Reply-To → normalized subject fallback.
 * WHY: Resend doesn't supply thread IDs; we synthesize one so related
 *      messages cluster in the inbox view.
 */
function deriveThreadId(inReplyTo, subject, fromEmail) {
  if (inReplyTo) return inReplyTo.trim();
  // Normalize subject: strip Re:/Fwd: prefixes + lowercase
  const normalized = (subject || '')
    .replace(/^(re|fwd?|fw):\s*/gi, '')
    .trim()
    .toLowerCase();
  // Fall back to from-email + subject so every new conversation is distinct
  return `thread:${fromEmail.toLowerCase()}:${normalized}`;
}

/**
 * Parse "Name <email>" or "email" format into { name, email }.
 */
function parseAddress(addr) {
  if (!addr) return { name: null, email: '' };
  const match = addr.match(/^([^<]+)<([^>]+)>/);
  if (match) {
    return { name: match[1].trim() || null, email: match[2].trim() };
  }
  return { name: null, email: addr.trim() };
}

/**
 * Fetch full inbound email content from Resend's Receiving API.
 * WHY: resend.emails.get() is for OUTBOUND emails only. Inbound emails
 * use GET /emails/receiving/{id} — the SDK doesn't expose this, so we
 * call the REST API directly.
 */
async function fetchEmailContent(resend, emailId) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return null;

    const resp = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      console.error(`[inbound-email] Receiving API returned ${resp.status} for email_id=${emailId}`);
      return null;
    }

    return await resp.json();
  } catch (err) {
    console.error('[inbound-email] Failed to fetch email content:', err.message);
    return null;
  }
}

/**
 * Send a forwarding notification to FORWARD_TO so Sean sees inbound emails
 * without logging into admin.
 */
async function sendForwardNotification(resend, { fromName, fromEmail, subject, bodyText, bodyHtml }) {
  const senderDisplay = fromName ? `${fromName} (${fromEmail})` : fromEmail;
  const fwdSubject = `FocusLedger reply from ${senderDisplay}: ${subject || '(no subject)'}`;

  const textBody = `You received a reply to FocusLedger from ${senderDisplay}.\n\nSubject: ${subject || '(no subject)'}\n\n---\n\n${bodyText || '(no plain text body)'}`;
  const htmlBody = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#2D2A26;">
      <p style="font-size:14px;color:#6B6560;">You received a reply to FocusLedger from <strong>${senderDisplay}</strong>.</p>
      <hr style="border:none;border-top:1px solid #E8E5E0;margin:16px 0;" />
      <p style="font-size:13px;color:#6B6560;">Subject: <strong>${subject || '(no subject)'}</strong></p>
      <hr style="border:none;border-top:1px solid #E8E5E0;margin:16px 0;" />
      ${bodyHtml || `<pre style="font-size:13px;white-space:pre-wrap;">${bodyText || '(no body)'}</pre>`}
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: [FORWARD_TO],
      // WHY: reply-to set to original sender so Sean can reply directly from Gmail
      reply_to: [fromEmail],
      subject: fwdSubject,
      html: htmlBody,
      text: textBody,
    });
    console.log(`[inbound-email] Forward notification sent to ${FORWARD_TO}`);
  } catch (err) {
    // Non-fatal — store the email regardless
    console.error('[inbound-email] Forward notification failed:', err.message);
  }
}

// =============================================================================
// Webhook: POST /api/webhooks/resend-inbound
// =============================================================================
// Mounted at root level (not under /api/inbox) so Resend can hit it without auth.
// Returns 200 immediately; processing is synchronous but fast.
module.exports = function(pool) {

  // Webhook endpoint — no auth, Resend calls this
  router.post('/webhook', async (req, res) => {
    // Acknowledge quickly — Resend expects 200
    res.status(200).json({ received: true });

    const payload = req.body;
    console.log(`[inbound-email] Webhook received: type=${payload?.type || 'unknown'}`);

    if (!payload || payload.type !== 'email.received') {
      console.log(`[inbound-email] Ignoring non-email.received event: ${payload?.type}`);
      return;
    }

    const data = payload.data || {};
    const emailId = data.email_id;
    if (!emailId) {
      console.warn('[inbound-email] Webhook missing email_id in payload.data');
      return;
    }

    console.log(`[inbound-email] Processing email_id=${emailId} from=${data.from} subject="${data.subject}"`);

    try {
      const resend = getResend();
      if (!resend) {
        console.error('[inbound-email] Cannot process — RESEND_API_KEY not set');
        return;
      }

      // Fetch full email content via Receiving API (webhook only has metadata)
      const email = await fetchEmailContent(resend, emailId);
      if (email) {
        console.log(`[inbound-email] Fetched full content for email_id=${emailId}`);
      } else {
        console.warn(`[inbound-email] Could not fetch content for email_id=${emailId}, using webhook metadata`);
      }

      const fromRaw = email?.from || data.from || '';
      const toRaw   = Array.isArray(email?.to || data.to) ? (email?.to || data.to)[0] : (email?.to || data.to);
      const { name: fromName, email: fromEmail } = parseAddress(fromRaw);
      const toEmail    = typeof toRaw === 'string' ? toRaw : '';
      const subject    = email?.subject || data.subject || '';
      const bodyText   = email?.text   || null;
      const bodyHtml   = email?.html   || null;

      // In-Reply-To from headers (array of {name,value} objects or key-value map)
      const headers    = email?.headers || [];
      let inReplyTo = null;
      if (Array.isArray(headers)) {
        inReplyTo = headers.find(h => h.name?.toLowerCase() === 'in-reply-to')?.value || null;
      } else if (typeof headers === 'object') {
        // WHY: Resend Receiving API may return headers as a flat object
        inReplyTo = headers['in-reply-to'] || headers['In-Reply-To'] || null;
      }
      const messageId  = email?.message_id || data.message_id || null;
      const threadId   = deriveThreadId(inReplyTo, subject, fromEmail);

      console.log(`[inbound-email] Inserting: from=${fromEmail} to=${toEmail} thread=${threadId} hasBody=${!!bodyText || !!bodyHtml}`);

      // Route emails sent to tasks@focusledger.net to the email-to-tasks handler.
      // WHY: these emails must not land in the admin inbox — they are task creation events.
      if (TASKS_ADDRESS_PATTERN.test(toEmail)) {
        console.log(`[inbound-email] → Routing to email-to-tasks handler (to=${toEmail})`);
        processEmailToTask(pool, {
          fromEmail,
          subject,
          bodyText,
          bodyHtml,
          messageId,
          emailId,
        }).catch(err => {
          console.error('[inbound-email] email-to-tasks processing error:', err.message);
        });
        return;
      }

      const { inserted } = await insertInboundEmail(pool, {
        fromEmail,
        fromName,
        toEmail,
        subject,
        bodyText,
        bodyHtml,
        inReplyTo,
        threadId,
        resendEmailId:   emailId,
        resendMessageId: messageId,
        receivedAt:      data.created_at || new Date().toISOString(),
      });

      if (!inserted) {
        console.log(`[inbound-email] Duplicate webhook for email_id=${emailId} — skipped`);
        return;
      }

      console.log(`[inbound-email] ✓ Stored inbound email from=${fromEmail} subject="${subject}" thread=${threadId}`);

      // Opt-out detection: campaign footers promise "reply 'no more' and we'll
      // never email you again" — this is the mechanism that keeps that promise.
      // The reply still lands in the admin inbox above, so it stays visible.
      try {
        const { isOptOutMessage, suppressEmail } = require('../lib/emailSuppression');
        if (fromEmail && isOptOutMessage(subject, bodyText)) {
          await suppressEmail(pool, fromEmail, 'reply_opt_out', `subject="${subject}"`);
          // One transactional confirmation (expected + polite; never repeated
          // because the address is now suppressed for everything marketing)
          const { sendEmail } = require('../lib/emailService');
          sendEmail(pool, {
            to: fromEmail,
            subject: 'You’re unsubscribed',
            html: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#141416;line-height:1.6;padding:16px;"><p>Done — you won’t get any more emails from FocusLedger.</p><p style="color:#888;font-size:13px;">(Account-related emails like password resets still work if you ever need them.)</p></div>',
            text: 'Done — you won\'t get any more emails from FocusLedger. (Account-related emails like password resets still work if you ever need them.)',
            templateType: 'unsubscribe_confirmation',
          }).catch(() => {});
          console.log(`[inbound-email] opt-out honored for ${fromEmail}`);
        }
      } catch (optErr) {
        console.error('[inbound-email] opt-out detection failed:', optErr.message, '| from:', fromEmail);
      }

      // Fire-and-forget forward notification to Sean
      sendForwardNotification(resend, { fromName, fromEmail, subject, bodyText, bodyHtml });

    } catch (err) {
      console.error(`[inbound-email] Webhook processing error for email_id=${emailId}:`, err.message, err.stack);
    }
  });

  // =============================================================================
  // Admin Inbox API — all endpoints require admin auth
  // =============================================================================

  function isAdminUser(user) {
    if (user.is_admin) return true;
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return adminEmails.includes((user.email || '').toLowerCase());
  }

  async function requireAdmin(req, res, pool) {
    const userId = req.user?.id;
    if (!userId) return false;
    const result = await queryWithRetry(pool, 'SELECT is_admin, email FROM users WHERE id = $1', [userId]);
    const user = result.rows[0] || {};
    if (!isAdminUser({ ...user, id: userId })) {
      res.status(403).json({ success: false, message: 'Admin access required' });
      return false;
    }
    return true;
  }

  // GET /api/inbox/threads — list conversation threads
  router.get('/threads', authenticateToken, async (req, res) => {
    try {
      if (!await requireAdmin(req, res, pool)) return;
      const threads = await listThreads(pool);
      const unread  = await countUnread(pool);
      res.json({ success: true, threads, unread });
    } catch (err) {
      console.error('[inbox] Error listing threads:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load inbox' });
    }
  });

  // GET /api/inbox/threads/:threadId — fetch all messages in a thread + mark read
  router.get('/threads/:threadId', authenticateToken, async (req, res) => {
    try {
      if (!await requireAdmin(req, res, pool)) return;
      const { threadId } = req.params;
      const decodedThreadId = decodeURIComponent(threadId);
      console.log(`[inbox] GET thread: ${decodedThreadId} by user ${req.user?.id}`);
      const messages = await getThread(pool, decodedThreadId);
      await markThreadRead(pool, decodedThreadId);
      res.json({ success: true, messages });
    } catch (err) {
      console.error('[inbox] Error fetching thread:', err.message, err.stack);
      res.status(500).json({ success: false, message: 'Failed to load thread' });
    }
  });

  // POST /api/inbox/threads/:threadId/reply — send a reply + store outbound record
  router.post('/threads/:threadId/reply', authenticateToken, async (req, res) => {
    try {
      if (!await requireAdmin(req, res, pool)) return;

      const { threadId } = req.params;
      const { body, to_email, subject } = req.body;

      if (!body || !body.trim()) {
        return res.status(400).json({ success: false, message: 'Reply body is required' });
      }
      if (!to_email) {
        return res.status(400).json({ success: false, message: 'to_email is required' });
      }

      const resend = getResend();
      if (!resend) {
        return res.status(500).json({ success: false, message: 'Email service unavailable' });
      }

      const replySubject = subject?.startsWith('Re:') ? subject : `Re: ${subject || '(no subject)'}`;

      // Send via Resend with proper threading headers
      const { data, error } = await resend.emails.send({
        from: FROM_ADDRESS,
        to:   [to_email],
        reply_to: ['hello@focusledger.net'],
        subject: replySubject,
        text: body,
        html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;color:#2D2A26;">${body.replace(/\n/g, '<br>')}</div>`,
        headers: {
          // WHY: In-Reply-To + References ensure email clients thread the reply
          //      correctly in the customer's inbox.
          'In-Reply-To': decodeURIComponent(threadId),
          'References':  decodeURIComponent(threadId),
        },
      });

      if (error) {
        console.error('[inbox] Resend reply error:', error);
        return res.status(500).json({ success: false, message: 'Failed to send reply' });
      }

      // Store outbound reply in customer_emails for full conversation history
      const stored = await insertOutboundEmail(pool, {
        fromEmail:       'hello@focusledger.net',
        toEmail:         to_email,
        subject:         replySubject,
        bodyText:        body,
        bodyHtml:        `<div style="white-space:pre-wrap;">${body.replace(/\n/g, '<br>')}</div>`,
        inReplyTo:       decodeURIComponent(threadId),
        threadId:        decodeURIComponent(threadId),
        resendMessageId: data?.id || null,
      });

      console.log(`[inbox] Reply sent to ${to_email} thread=${threadId}`);
      res.json({ success: true, message: stored });

    } catch (err) {
      console.error('[inbox] Error sending reply:', err.message);
      res.status(500).json({ success: false, message: 'Failed to send reply' });
    }
  });

  // PATCH /api/inbox/threads/:threadId/read — mark thread as read
  router.patch('/threads/:threadId/read', authenticateToken, async (req, res) => {
    try {
      if (!await requireAdmin(req, res, pool)) return;
      await markThreadRead(pool, decodeURIComponent(req.params.threadId));
      res.json({ success: true });
    } catch (err) {
      console.error('[inbox] Error marking read:', err.message);
      res.status(500).json({ success: false, message: 'Failed to mark read' });
    }
  });

  return router;
};
