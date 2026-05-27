'use strict';
/**
 * db/customer-emails.js — Named query functions for customer_emails table.
 *
 * Owns: customer_emails (inbound + outbound two-way admin inbox)
 * Does NOT own: email_log (outbound marketing emails), emailService.js send logic
 *
 * All functions accept pool as first argument. No module-level pool state.
 */

/**
 * Insert an inbound email. Ignores duplicates on resend_email_id.
 * Returns { inserted: boolean, row: object|null }
 */
async function insertInboundEmail(pool, {
  fromEmail, fromName, toEmail, subject,
  bodyText, bodyHtml, inReplyTo, threadId,
  resendEmailId, resendMessageId, receivedAt
}) {
  const result = await pool.query(
    `INSERT INTO customer_emails
       (from_email, from_name, to_email, subject, body_text, body_html,
        in_reply_to, thread_id, direction, resend_email_id, resend_message_id, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'inbound', $9, $10, $11)
     ON CONFLICT (resend_email_id) DO NOTHING
     RETURNING *`,
    [fromEmail, fromName || null, toEmail, subject || null,
     bodyText || null, bodyHtml || null,
     inReplyTo || null, threadId || null,
     resendEmailId, resendMessageId || null,
     receivedAt ? new Date(receivedAt) : new Date()]
  );
  return {
    inserted: result.rows.length > 0,
    row: result.rows[0] || null
  };
}

/**
 * Insert an outbound reply sent from admin inbox.
 * Returns the inserted row.
 */
async function insertOutboundEmail(pool, {
  fromEmail, toEmail, subject,
  bodyText, bodyHtml, inReplyTo, threadId,
  resendMessageId
}) {
  const result = await pool.query(
    `INSERT INTO customer_emails
       (from_email, to_email, subject, body_text, body_html,
        in_reply_to, thread_id, direction, resend_message_id, read)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'outbound', $8, true)
     RETURNING *`,
    [fromEmail, toEmail, subject || null,
     bodyText || null, bodyHtml || null,
     inReplyTo || null, threadId || null,
     resendMessageId || null]
  );
  return result.rows[0];
}

/**
 * List conversation threads (one row per thread, latest message info).
 * Sorted by most recent message descending.
 */
async function listThreads(pool, { limit = 50, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT
       thread_id,
       MIN(subject) AS subject,
       MIN(from_email) FILTER (WHERE direction = 'inbound') AS customer_email,
       MIN(from_name)  FILTER (WHERE direction = 'inbound') AS customer_name,
       COUNT(*)::int   AS message_count,
       COUNT(*) FILTER (WHERE read = false AND direction = 'inbound')::int AS unread_count,
       MAX(received_at) AS last_message_at
     FROM customer_emails
     GROUP BY thread_id
     ORDER BY last_message_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

/**
 * Fetch all messages in a thread, oldest first.
 */
async function getThread(pool, threadId) {
  const result = await pool.query(
    `SELECT * FROM customer_emails
     WHERE thread_id = $1
     ORDER BY received_at ASC`,
    [threadId]
  );
  return result.rows;
}

/**
 * Mark all inbound messages in a thread as read.
 */
async function markThreadRead(pool, threadId) {
  await pool.query(
    `UPDATE customer_emails SET read = true
     WHERE thread_id = $1 AND direction = 'inbound' AND read = false`,
    [threadId]
  );
}

/**
 * Count total unread inbound emails (for badge).
 */
async function countUnread(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM customer_emails
     WHERE direction = 'inbound' AND read = false`
  );
  return result.rows[0].count;
}

module.exports = {
  insertInboundEmail,
  insertOutboundEmail,
  listThreads,
  getThread,
  markThreadRead,
  countUnread,
};
