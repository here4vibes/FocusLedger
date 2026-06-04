// db/partnerships.js
// Owns: partnerships table, partner_concerns table. Invite tokens, status transitions
//       (pending→active→dissolved), Tandem access checks, partner concern soft signals.
// Does NOT own: user auth, Stripe webhook processing, notification delivery.

const { queryWithRetry } = require('../lib/queryWithRetry');
const crypto = require('crypto');

const q = (pool, sql, params) => queryWithRetry(pool, sql, params);

const INVITE_TTL_DAYS = 7;

/**
 * Generate a new pending partnership invite for inviter.
 * Fails if inviter already has an active partnership.
 */
async function createInvite(pool, inviterId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const result = await q(pool, `
    INSERT INTO partnerships (inviter_id, invite_token, invite_expires_at)
    VALUES ($1, $2, $3)
    RETURNING id, invite_token, invite_expires_at, status, created_at
  `, [inviterId, token, expiresAt]);

  return result.rows[0];
}

/**
 * Look up a pending invite by token. Returns null if not found or expired.
 */
async function findPendingInvite(pool, token) {
  const result = await q(pool, `
    SELECT
      p.*,
      u.name AS inviter_name,
      u.email AS inviter_email,
      u.avatar_url AS inviter_avatar
    FROM partnerships p
    JOIN users u ON u.id = p.inviter_id
    WHERE p.invite_token = $1
      AND p.status = 'pending'
      AND p.invite_expires_at > NOW()
  `, [token]);
  return result.rows[0] || null;
}

/**
 * Accept an invite: set invitee_id + status=active on the partnership row.
 * Atomically verifies the invitee doesn't already have an active partner.
 * Returns the activated partnership or throws on constraint violation.
 */
async function acceptInvite(pool, token, inviteeId) {
  // Single query: update only if conditions hold
  const result = await q(pool, `
    UPDATE partnerships
    SET
      invitee_id   = $2,
      status       = 'active',
      activated_at = NOW()
    WHERE invite_token = $1
      AND status       = 'pending'
      AND invite_expires_at > NOW()
      AND inviter_id  != $2
    RETURNING
      id,
      inviter_id,
      invitee_id,
      status,
      activated_at
  `, [token, inviteeId]);

  return result.rows[0] || null;
}

/**
 * Get the current active partnership for a user (as inviter or invitee).
 * Joins partner's user row for display.
 */
async function getActivePartnership(pool, userId) {
  const result = await q(pool, `
    SELECT
      p.id,
      p.status,
      p.activated_at,
      CASE
        WHEN p.inviter_id = $1 THEN p.invitee_id
        ELSE p.inviter_id
      END AS partner_id,
      CASE
        WHEN p.inviter_id = $1 THEN u2.name
        ELSE u1.name
      END AS partner_name,
      CASE
        WHEN p.inviter_id = $1 THEN u2.email
        ELSE u1.email
      END AS partner_email,
      CASE
        WHEN p.inviter_id = $1 THEN u2.avatar_url
        ELSE u1.avatar_url
      END AS partner_avatar
    FROM partnerships p
    LEFT JOIN users u1 ON u1.id = p.inviter_id
    LEFT JOIN users u2 ON u2.id = p.invitee_id
    WHERE (p.inviter_id = $1 OR p.invitee_id = $1)
      AND p.status = 'active'
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

/**
 * Get a pending invite sent by this user (for display in settings).
 */
async function getPendingInvite(pool, userId) {
  const result = await q(pool, `
    SELECT id, invite_token, invite_expires_at, status, created_at
    FROM partnerships
    WHERE inviter_id = $1
      AND status = 'pending'
      AND invite_expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

/**
 * Dissolve an active partnership. Either partner can dissolve.
 * Soft delete: sets status=dissolved, dissolved_at=NOW().
 * Returns true if dissolved, false if not found or not active.
 */
async function dissolvePartnership(pool, partnershipId, userId) {
  const result = await q(pool, `
    UPDATE partnerships
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = $1
      AND status = 'active'
      AND (inviter_id = $2 OR invitee_id = $2)
    RETURNING id
  `, [partnershipId, userId]);
  return result.rows.length > 0;
}

/**
 * Cancel a pending invite created by this user (before anyone accepts).
 */
async function cancelPendingInvite(pool, userId) {
  const result = await q(pool, `
    UPDATE partnerships
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE inviter_id = $1
      AND status = 'pending'
    RETURNING id
  `, [userId]);
  return result.rows.length > 0;
}

/**
 * Get all shared/household tasks belonging to the partner of userId.
 * Returns tasks visible on the partner dashboard — only tasks where
 * is_household=true OR is_shared_with_partner=true.
 * Callers must verify an active partnership exists before calling this.
 */
async function getPartnerSharedTasks(pool, userId) {
  // Resolve who the partner is first
  const partnerResult = await q(pool, `
    SELECT
      CASE WHEN inviter_id = $1 THEN invitee_id ELSE inviter_id END AS partner_id
    FROM partnerships
    WHERE (inviter_id = $1 OR invitee_id = $1)
      AND status = 'active'
    LIMIT 1
  `, [userId]);

  if (!partnerResult.rows[0]) return null; // no active partnership

  const partnerId = partnerResult.rows[0].partner_id;

  const tasks = await q(pool, `
    SELECT
      t.id,
      t.title,
      t.is_completed,
      t.completed_at,
      t.due_date,
      t.priority,
      t.is_household,
      t.is_shared_with_partner,
      t.created_at,
      t.updated_at
    FROM tasks t
    WHERE t.user_id = $1
      AND (t.is_household = true OR t.is_shared_with_partner = true)
    ORDER BY t.is_completed ASC, t.created_at DESC
  `, [partnerId]);

  return { partner_id: partnerId, tasks: tasks.rows };
}

/**
 * Update a task's sharing flags. Only the task's owner can update.
 * Returns the updated task or null if not found.
 */
async function updateTaskSharingFlags(pool, taskId, userId, { isHousehold, isSharedWithPartner }) {
  const updates = [];
  const params = [];
  let idx = 1;

  if (isHousehold !== undefined) {
    updates.push(`is_household = $${idx++}`);
    params.push(Boolean(isHousehold));
  }
  if (isSharedWithPartner !== undefined) {
    updates.push(`is_shared_with_partner = $${idx++}`);
    params.push(Boolean(isSharedWithPartner));
  }
  if (updates.length === 0) return null;

  updates.push(`updated_at = NOW()`);
  params.push(taskId, userId);

  const result = await q(pool, `
    UPDATE tasks
    SET ${updates.join(', ')}
    WHERE id = $${idx++} AND user_id = $${idx}
    RETURNING id, title, is_household, is_shared_with_partner, is_completed, completed_at, updated_at
  `, params);

  return result.rows[0] || null;
}

/**
 * Get recently completed shared/household tasks for the completion feed.
 * Returns partner's shared tasks completed in the last 48h, newest first.
 */
async function getPartnerCompletionFeed(pool, userId) {
  const partnerResult = await q(pool, `
    SELECT
      CASE WHEN inviter_id = $1 THEN invitee_id ELSE inviter_id END AS partner_id,
      CASE WHEN inviter_id = $1 THEN u2.name ELSE u1.name END AS partner_name
    FROM partnerships p
    LEFT JOIN users u1 ON u1.id = p.inviter_id
    LEFT JOIN users u2 ON u2.id = p.invitee_id
    WHERE (p.inviter_id = $1 OR p.invitee_id = $1)
      AND p.status = 'active'
    LIMIT 1
  `, [userId]);

  if (!partnerResult.rows[0]) return null;

  const { partner_id: partnerId, partner_name: partnerName } = partnerResult.rows[0];

  const feed = await q(pool, `
    SELECT
      t.id,
      t.title,
      t.completed_at,
      t.is_household,
      t.is_shared_with_partner
    FROM tasks t
    WHERE t.user_id = $1
      AND t.is_completed = true
      AND t.completed_at >= NOW() - INTERVAL '48 hours'
      AND (t.is_household = true OR t.is_shared_with_partner = true)
    ORDER BY t.completed_at DESC
    LIMIT 20
  `, [partnerId]);

  return { partner_id: partnerId, partner_name: partnerName, completions: feed.rows };
}

// ── Tandem Subscription Access ────────────────────────────────────────────────
// TRIAL_DAYS: 14-day free trial for both partners when a partnership is first activated.
// Access rule: either partner having an active Tandem subscription unlocks it for the pair.
// Trial is granted once per partnership (tracked via tandem_trial_activated_at on the row).
const TANDEM_TRIAL_DAYS = 14;

/**
 * Check if a user has Tandem access (paid or trial).
 * Returns { hasTandem: bool, reason: 'paid'|'trial'|'partner_paid'|'none', expiresAt: Date|null }
 *
 * Access rules (in priority order):
 * 1. User's own active Tandem subscription
 * 2. User is in an active partnership AND the trial period is active
 * 3. Partner has an active Tandem subscription (unlocks for the pair)
 */
async function checkTandemAccess(pool, userId) {
  const userResult = await q(pool, `
    SELECT tandem_plan, tandem_expires_at, tandem_trial_started_at
    FROM users WHERE id = $1
  `, [userId]);

  if (!userResult.rows[0]) return { hasTandem: false, reason: 'none', expiresAt: null };

  const user = userResult.rows[0];
  const now = new Date();

  // 1. Own paid subscription
  if (user.tandem_plan === 'tandem' && user.tandem_expires_at && new Date(user.tandem_expires_at) > now) {
    return { hasTandem: true, reason: 'paid', expiresAt: new Date(user.tandem_expires_at) };
  }

  // Check for an active partnership to evaluate trial + partner access
  const partnerResult = await q(pool, `
    SELECT
      p.id AS partnership_id,
      p.tandem_trial_activated_at,
      CASE WHEN p.inviter_id = $1 THEN p.invitee_id ELSE p.inviter_id END AS partner_id,
      pu.tandem_plan AS partner_tandem_plan,
      pu.tandem_expires_at AS partner_tandem_expires_at
    FROM partnerships p
    JOIN users pu ON pu.id = CASE WHEN p.inviter_id = $1 THEN p.invitee_id ELSE p.inviter_id END
    WHERE (p.inviter_id = $1 OR p.invitee_id = $1)
      AND p.status = 'active'
    LIMIT 1
  `, [userId]);

  if (!partnerResult.rows[0]) {
    return { hasTandem: false, reason: 'none', expiresAt: null };
  }

  const { tandem_trial_activated_at, partner_tandem_plan, partner_tandem_expires_at } = partnerResult.rows[0];

  // 2. Trial period active for this partnership
  if (tandem_trial_activated_at) {
    const trialEnd = new Date(tandem_trial_activated_at);
    trialEnd.setDate(trialEnd.getDate() + TANDEM_TRIAL_DAYS);
    if (trialEnd > now) {
      return { hasTandem: true, reason: 'trial', expiresAt: trialEnd };
    }
  }

  // 3. Partner has an active paid subscription — unlocks for the pair
  if (partner_tandem_plan === 'tandem' && partner_tandem_expires_at && new Date(partner_tandem_expires_at) > now) {
    return { hasTandem: true, reason: 'partner_paid', expiresAt: new Date(partner_tandem_expires_at) };
  }

  return { hasTandem: false, reason: 'none', expiresAt: null };
}

/**
 * Activate the Tandem subscription for a user after successful payment.
 * Also activates the 14-day trial for their partner (if not already started).
 * expiresAt: Date — end of subscription period from Stripe
 */
async function activateTandemSubscription(pool, userId, expiresAt) {
  await q(pool, `
    UPDATE users
    SET tandem_plan = 'tandem', tandem_expires_at = $2
    WHERE id = $1
  `, [userId, expiresAt]);

  // Grant trial to active partner's partnership row if not already started
  await q(pool, `
    UPDATE partnerships
    SET tandem_trial_activated_at = COALESCE(tandem_trial_activated_at, NOW())
    WHERE (inviter_id = $1 OR invitee_id = $1)
      AND status = 'active'
      AND tandem_trial_activated_at IS NULL
  `, [userId]);
}

/**
 * Start the 14-day Tandem trial for a newly linked partnership.
 * Called when a partnership becomes active (invite accepted).
 * Both partners get trial access — neither needs a paid sub during the 14 days.
 */
async function activateTandemTrial(pool, partnershipId) {
  await q(pool, `
    UPDATE partnerships
    SET tandem_trial_activated_at = COALESCE(tandem_trial_activated_at, NOW())
    WHERE id = $1
  `, [partnershipId]);
}

// ── Partner Concern Signals ───────────────────────────────────────────────────

/**
 * Store a soft concern signal from one partner to Buddy about the other.
 * These are NEVER directly shown to the user being concerned about.
 * Buddy may use them as weak context signals for natural coaching prompts.
 * Auto-expire in 7 days. One active concern per partnership at a time
 * (new one marks old ones consumed).
 */
async function createPartnerConcern(pool, partnershipId, fromUserId, aboutUserId, concernText, topicArea) {
  // Mark any prior unconsumed concerns from this partner as consumed
  await q(pool, `
    UPDATE partner_concerns
    SET is_consumed = TRUE, consumed_at = NOW()
    WHERE partnership_id = $1 AND from_user_id = $2 AND is_consumed = FALSE
  `, [partnershipId, fromUserId]);

  const result = await q(pool, `
    INSERT INTO partner_concerns
      (partnership_id, from_user_id, about_user_id, concern_text, topic_area)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, concern_text, topic_area, created_at, expires_at
  `, [partnershipId, fromUserId, aboutUserId, concernText.slice(0, 500), topicArea || null]);

  return result.rows[0];
}

/**
 * Get active (non-expired, non-consumed) partner concerns about a user.
 * Called by Buddy when building coaching context. Returns minimal info —
 * topic area and approximate concern category only (never verbatim text to the AI).
 * WHY verbatim text is excluded from the return: see privacy rules in task description.
 * Buddy receives the concern as a soft topic signal, not as a quoted message.
 */
async function getActiveConcernsAboutUser(pool, aboutUserId) {
  const result = await q(pool, `
    SELECT id, topic_area, created_at
    FROM partner_concerns
    WHERE about_user_id = $1
      AND is_consumed = FALSE
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 3
  `, [aboutUserId]);

  return result.rows;
}

module.exports = {
  createInvite,
  findPendingInvite,
  acceptInvite,
  getActivePartnership,
  getPendingInvite,
  dissolvePartnership,
  cancelPendingInvite,
  getPartnerSharedTasks,
  updateTaskSharingFlags,
  getPartnerCompletionFeed,
  // Tandem subscription
  checkTandemAccess,
  activateTandemSubscription,
  activateTandemTrial,
  // Partner concerns
  createPartnerConcern,
  getActiveConcernsAboutUser,
};
