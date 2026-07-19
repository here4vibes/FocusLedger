// routes/revenuecat-webhook.js — receives RevenueCat store events and syncs the
// Autopilot entitlement into the DB, so an iOS purchase = Autopilot everywhere.
// Owns: POST /api/revenuecat/webhook. See docs/ios-launch-runbook.md (Phase 3).
//
// Auth: RevenueCat sends a fixed Authorization header you set in its dashboard;
// we compare it to REVENUECAT_WEBHOOK_AUTH. The SDK is configured to identify
// users by their FocusLedger user id, so event.app_user_id is that id.

const express = require('express');
const { grantAutopilot, revokeAutopilot } = require('../db/subscriptions');

const ENTITLEMENT = process.env.REVENUECAT_ENTITLEMENT || 'autopilot';
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

// Event types that end access vs. grant/extend it.
const REVOKE_TYPES = new Set(['EXPIRATION', 'SUBSCRIPTION_PAUSED']);
const GRANT_TYPES = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TRANSFER',
]);
// CANCELLATION / BILLING_ISSUE intentionally do nothing: access persists until
// the paid period actually expires (RevenueCat sends EXPIRATION then).

/**
 * Decide what a RevenueCat event means for our entitlement. Pure + testable.
 * @returns {{action:'grant'|'revoke'|'noop'|'skip'|'test', userId?:number, expiry?:Date, reason:string}}
 */
function resolveAction(event, nowMs) {
  if (!event || !event.type) return { action: 'skip', reason: 'no event' };
  if (event.type === 'TEST') return { action: 'test', reason: 'test event' };

  const userId = parseInt(event.app_user_id, 10);
  if (!userId) return { action: 'skip', reason: 'anonymous app_user_id' };

  // Some events omit entitlement info → treat as relevant to be safe.
  const ents = new Set([...(event.entitlement_ids || []), event.entitlement_id].filter(Boolean));
  if (ents.size > 0 && !ents.has(ENTITLEMENT)) {
    return { action: 'skip', userId, reason: 'other entitlement' };
  }

  if (REVOKE_TYPES.has(event.type)) {
    return { action: 'revoke', userId, reason: event.type };
  }
  if (GRANT_TYPES.has(event.type) || (event.expiration_at_ms && event.expiration_at_ms > nowMs)) {
    const expiry = event.expiration_at_ms ? new Date(event.expiration_at_ms) : FAR_FUTURE;
    return { action: 'grant', userId, expiry, reason: event.type };
  }
  return { action: 'noop', userId, reason: event.type };
}

module.exports = function (pool) {
  const router = express.Router();

  router.post('/webhook', async (req, res) => {
    // Verify the shared secret. Reject (don't silently accept) if unconfigured.
    const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!expected) {
      console.error('[RevenueCat] REVENUECAT_WEBHOOK_AUTH not set — rejecting webhook');
      return res.status(500).json({ success: false, message: 'webhook not configured' });
    }
    if (req.get('authorization') !== expected) {
      console.warn('[RevenueCat] webhook auth mismatch — rejected');
      return res.status(401).json({ success: false, message: 'unauthorized' });
    }

    const decision = resolveAction(req.body && req.body.event, Date.now());

    try {
      if (decision.action === 'grant') {
        await grantAutopilot(pool, decision.userId, decision.expiry);
        console.log('[RevenueCat] granted Autopilot | userId:', decision.userId, '| type:', decision.reason, '| until:', decision.expiry.toISOString());
      } else if (decision.action === 'revoke') {
        await revokeAutopilot(pool, decision.userId);
        console.log('[RevenueCat] revoked Autopilot | userId:', decision.userId, '| type:', decision.reason);
      } else {
        console.log('[RevenueCat] webhook', decision.action, '—', decision.reason, decision.userId ? '| userId: ' + decision.userId : '');
      }
      return res.status(200).json({ success: true, action: decision.action });
    } catch (err) {
      // 500 so RevenueCat retries — never drop a paid entitlement silently.
      console.error('[RevenueCat] webhook processing failed:', err.message, '| userId:', decision.userId, '| type:', decision.reason);
      return res.status(500).json({ success: false, message: 'processing failed' });
    }
  });

  return router;
};

module.exports.resolveAction = resolveAction;
