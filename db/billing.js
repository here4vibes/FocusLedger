'use strict';
/**
 * Billing queries (app_subscription + the users billing columns). Pure data
 * access — interpretation of Stripe objects lives in lib/billing.js.
 * Functions throw on unexpected errors; callers decide how to respond.
 */

async function findBySessionId(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT id, user_id FROM app_subscription WHERE checkout_session_id = $1 LIMIT 1',
    [sessionId]
  );
  return rows[0] || null;
}

async function findUserIdByEmail(pool, email) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  return rows[0] ? rows[0].id : null;
}

async function getUserContact(pool, userId) {
  const { rows } = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

async function getLatestSubscription(pool, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

/**
 * Record a paid checkout atomically: subscription row + users flags (+ Tandem
 * access and the partner's trial when the plan is Tandem).
 * @returns {{ duplicate: boolean, firstActivation?: boolean }}
 *   duplicate: this checkout session was already recorded (UNIQUE violation —
 *   the webhook and the success redirect raced; the other one won).
 */
async function recordActivation(pool, {
  userId, sessionId, subscriptionId, customerId, billingCycle, periodEnd, tandemExpiresAt,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      'SELECT id, activated_at FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [userId]
    );
    const firstActivation = !(prev.rows[0] && prev.rows[0].activated_at);
    const periodIso = periodEnd ? periodEnd.toISOString() : null;

    if (prev.rows[0]) {
      await client.query(`
        UPDATE app_subscription
        SET plan = 'pro', status = 'active', billing_cycle = $1,
            stripe_subscription_id = $2, stripe_customer_id = COALESCE($3, stripe_customer_id),
            checkout_session_id = $4, current_period_end = $5,
            activated_at = COALESCE(activated_at, NOW()), cancelled_at = NULL, updated_at = NOW()
        WHERE id = $6
      `, [billingCycle, subscriptionId, customerId, sessionId, periodIso, prev.rows[0].id]);
    } else {
      await client.query(`
        INSERT INTO app_subscription
          (plan, status, billing_cycle, stripe_subscription_id, stripe_customer_id,
           checkout_session_id, current_period_end, user_id, activated_at)
        VALUES ('pro', 'active', $1, $2, $3, $4, $5, $6, NOW())
      `, [billingCycle, subscriptionId, customerId, sessionId, periodIso, userId]);
    }

    await client.query(`UPDATE users SET pro_granted_by = 'stripe' WHERE id = $1`, [userId]);

    if (tandemExpiresAt) {
      await client.query(
        `UPDATE users SET tandem_plan = 'tandem', tandem_expires_at = $2 WHERE id = $1`,
        [userId, tandemExpiresAt]
      );
      // Same partner-trial grant as db/partnerships.activateTandemSubscription.
      await client.query(`
        UPDATE partnerships
        SET tandem_trial_activated_at = COALESCE(tandem_trial_activated_at, NOW())
        WHERE (inviter_id = $1 OR invitee_id = $1)
          AND status = 'active'
          AND tandem_trial_activated_at IS NULL
      `, [userId]);
    }

    await client.query('COMMIT');
    return { duplicate: false, firstActivation };
  } catch (err) {
    await client.query('ROLLBACK').catch(rbErr =>
      console.error('[billing] rollback failed:', rbErr.message, '| session:', sessionId));
    if (err.code === '23505') return { duplicate: true };
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mirror a Stripe subscription's state onto our row.
 * cancelScheduled=true marks a pending end-of-period cancellation (status stays
 * 'active' so access continues until Stripe actually ends it).
 * @returns the updated row ({ id, user_id }) or null if we don't know this subscription.
 */
async function syncByStripeSubscription(pool, {
  subscriptionId, status, periodEnd, billingCycle, cancelScheduled,
}) {
  const { rows } = await pool.query(`
    UPDATE app_subscription
    SET status = $2,
        current_period_end = COALESCE($3, current_period_end),
        billing_cycle = COALESCE($4, billing_cycle),
        cancelled_at = CASE
          WHEN $5 OR $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
    WHERE stripe_subscription_id = $1
    RETURNING id, user_id
  `, [subscriptionId, status, periodEnd ? periodEnd.toISOString() : null, billingCycle, !!cancelScheduled]);
  if (!rows[0]) {
    console.warn('[billing] subscription event for unknown subscription:', subscriptionId);
  }
  return rows[0] || null;
}

async function markPastDue(pool, subscriptionId) {
  const { rowCount } = await pool.query(
    `UPDATE app_subscription SET status = 'past_due', updated_at = NOW()
     WHERE stripe_subscription_id = $1 AND status = 'active'`,
    [subscriptionId]
  );
  return rowCount;
}

async function setTandem(pool, userId, expiresAt) {
  await pool.query(
    `UPDATE users SET tandem_plan = 'tandem', tandem_expires_at = $2 WHERE id = $1`,
    [userId, expiresAt]
  );
}

async function endTandem(pool, userId) {
  await pool.query(
    `UPDATE users SET tandem_expires_at = LEAST(COALESCE(tandem_expires_at, NOW()), NOW())
     WHERE id = $1 AND tandem_plan = 'tandem'`,
    [userId]
  );
}

async function setCancelScheduled(pool, rowId, periodEnd) {
  await pool.query(`
    UPDATE app_subscription
    SET cancelled_at = NOW(), current_period_end = COALESCE($2, current_period_end), updated_at = NOW()
    WHERE id = $1
  `, [rowId, periodEnd ? periodEnd.toISOString() : null]);
}

async function clearCancelScheduled(pool, rowId) {
  await pool.query(
    'UPDATE app_subscription SET cancelled_at = NULL, updated_at = NOW() WHERE id = $1',
    [rowId]
  );
}

/** Stripe subscriptions on this user's rows that may still bill. */
async function listBillableStripeSubscriptions(pool, userId) {
  const { rows } = await pool.query(`
    SELECT id, stripe_subscription_id FROM app_subscription
    WHERE user_id = $1 AND stripe_subscription_id LIKE 'sub_%'
      AND status IN ('active', 'past_due', 'unpaid', 'incomplete')
  `, [userId]);
  return rows;
}

module.exports = {
  findBySessionId,
  findUserIdByEmail,
  getUserContact,
  getLatestSubscription,
  recordActivation,
  syncByStripeSubscription,
  markPastDue,
  setTandem,
  endTandem,
  setCancelScheduled,
  clearCancelScheduled,
  listBillableStripeSubscriptions,
};
