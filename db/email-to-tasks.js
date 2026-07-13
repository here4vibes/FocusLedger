'use strict';

const MAX_LINKED_EMAILS = 5;

async function findUserByEmail(pool, fromEmail) {
  const { rows } = await pool.query(
    `SELECT u.id, u.admin_pro_override, u.pro_granted_until,
            s.plan AS plan, s.status AS sub_status
     FROM linked_emails le
     JOIN users u ON u.id = le.user_id
     LEFT JOIN app_subscription s ON s.user_id = u.id AND s.status = 'active'
     WHERE le.email = $1 AND le.verified = true
     LIMIT 1`,
    [fromEmail.toLowerCase().trim()]
  );
  return rows[0] || null;
}

async function addLinkedEmail(pool, userId, fromEmail) {
  const { rows: existing } = await pool.query(
    'SELECT COUNT(*) AS cnt FROM linked_emails WHERE user_id = $1',
    [userId]
  );
  if (parseInt(existing[0].cnt, 10) >= MAX_LINKED_EMAILS) {
    return { added: false, reason: 'max_linked_emails' };
  }
  await pool.query(
    `INSERT INTO linked_emails (user_id, email, verified)
     VALUES ($1, $2, false)
     ON CONFLICT (user_id, email) DO NOTHING`,
    [userId, fromEmail.toLowerCase().trim()]
  );
  return { added: true };
}

async function listLinkedEmails(pool, userId) {
  const { rows } = await pool.query(
    'SELECT id, email, verified, created_at FROM linked_emails WHERE user_id = $1 ORDER BY created_at',
    [userId]
  );
  return rows;
}

async function removeLinkedEmail(pool, id, userId) {
  await pool.query(
    'DELETE FROM linked_emails WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
}

async function stashEmail(pool, { fromEmail, subject, bodyText, bodyHtml, messageId, token }) {
  await pool.query(
    `INSERT INTO email_tasks_stash (from_email, subject, body_text, body_html, message_id, claim_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '72 hours')
     ON CONFLICT (message_id) DO NOTHING`,
    [fromEmail, subject, bodyText, bodyHtml, messageId, token]
  );
}

async function findStashByToken(pool, token) {
  const { rows } = await pool.query(
    `SELECT id, from_email, subject, body_text
     FROM email_tasks_stash
     WHERE claim_token = $1 AND claimed_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function claimStash(pool, token) {
  await pool.query(
    'UPDATE email_tasks_stash SET claimed_at = NOW() WHERE claim_token = $1',
    [token]
  );
}

async function purgeExpiredStash(pool) {
  const { rowCount } = await pool.query(
    'DELETE FROM email_tasks_stash WHERE expires_at < NOW()'
  );
  return rowCount;
}

/**
 * Best-effort dedup for re-delivered inbound webhooks. Returns true if this
 * message_id has already been stashed (the one table that durably records
 * message_id, with a UNIQUE constraint). Guards processEmailToTask against
 * Resend re-delivering the same inbound email.
 *
 * LIMITATION: known-sender emails become tasks directly and are NOT stashed,
 * so a re-delivery for a verified sender isn't caught here. Fully closing that
 * gap needs a durable processed-message_id record (schema change) — tracked
 * separately. This function was imported by routes/email-to-tasks.js but never
 * defined, so the dedup guard threw "isMessageDuplicate is not a function".
 * @param {object} pool
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
async function isMessageDuplicate(pool, messageId) {
  if (!messageId) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM email_tasks_stash WHERE message_id = $1 LIMIT 1',
    [messageId]
  );
  return rows.length > 0;
}

async function insertEmailTask(pool, { userId, title, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (user_id, title, notes, source)
     VALUES ($1, $2, $3, 'email')
     RETURNING id, title`,
    [userId, title, notes || null]
  );
  return rows[0];
}

module.exports = {
  findUserByEmail, addLinkedEmail, listLinkedEmails, removeLinkedEmail,
  stashEmail, findStashByToken, claimStash, purgeExpiredStash, insertEmailTask,
  isMessageDuplicate,
};
