// db/lead-magnets.js
// Named query functions for lead_magnet_emails table.
// No raw SQL outside this file.

const { queryWithRetry } = require('../lib/queryWithRetry');

/**
 * Store an email capture for a lead magnet download.
 * Uses ON CONFLICT DO NOTHING so repeated submissions are idempotent.
 * @param {Pool} pool
 * @param {string} email
 * @param {string} leadMagnetType - 'science_cheat_sheet' | 'daily_three'
 * @param {string|null} sourcePage
 * @returns {Promise<{new: boolean, id: number}>}
 */
async function captureLeadEmail(pool, email, leadMagnetType, sourcePage = null) {
  const result = await queryWithRetry(pool, `
    INSERT INTO lead_magnet_emails (email, lead_magnet_type, source_page)
    VALUES ($1, $2, $3)
    ON CONFLICT (email, lead_magnet_type) DO NOTHING
    RETURNING id
  `, [email.trim().toLowerCase(), leadMagnetType, sourcePage]);

  if (result.rows.length > 0) {
    return { new: true, id: result.rows[0].id };
  }
  return { new: false, id: null };
}

/**
 * Get all captured leads for a given magnet type (admin use).
 * @param {Pool} pool
 * @param {string|null} leadMagnetType - filter by type, or null for all
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<Array>}
 */
async function getLeads(pool, leadMagnetType = null, limit = 100, offset = 0) {
  let sql = `
    SELECT id, email, lead_magnet_type, source_page, captured_at
    FROM lead_magnet_emails
  `;
  const params = [];

  if (leadMagnetType) {
    sql += ` WHERE lead_magnet_type = $1`;
    params.push(leadMagnetType);
  }

  sql += ` ORDER BY captured_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  return (await queryWithRetry(pool, sql, params)).rows;
}

/**
 * Get total count of leads, optionally filtered by type.
 * @param {Pool} pool
 * @param {string|null} leadMagnetType
 * @returns {Promise<number>}
 */
async function getLeadsCount(pool, leadMagnetType = null) {
  let sql = `SELECT COUNT(*) as count FROM lead_magnet_emails`;
  const params = [];
  if (leadMagnetType) {
    sql += ` WHERE lead_magnet_type = $1`;
    params.push(leadMagnetType);
  }
  const result = await queryWithRetry(pool, sql, params);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get unconverted leads: email captures with no matching registered user.
 * Sorted by captured_at DESC (most recent first).
 * @param {Pool} pool
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<Array>}
 */
async function getUnconvertedLeads(pool, limit = 200, offset = 0) {
  return (await queryWithRetry(pool, `
    SELECT
      lme.id,
      lme.email,
      lme.lead_magnet_type,
      lme.source_page,
      lme.captured_at,
      NOW()::date - lme.captured_at::date AS days_since_capture
    FROM lead_magnet_emails lme
    WHERE NOT EXISTS (
      SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(lme.email)
    )
    ORDER BY lme.captured_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset])).rows;
}

/**
 * Get total count of unconverted leads.
 * @param {Pool} pool
 * @returns {Promise<number>}
 */
async function getUnconvertedLeadsCount(pool) {
  const result = await queryWithRetry(pool, `
    SELECT COUNT(*) as count
    FROM lead_magnet_emails lme
    WHERE NOT EXISTS (
      SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(lme.email)
    )
  `, []);
  return parseInt(result.rows[0].count, 10);
}

module.exports = { captureLeadEmail, getLeads, getLeadsCount, getUnconvertedLeads, getUnconvertedLeadsCount };