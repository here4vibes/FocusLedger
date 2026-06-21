'use strict';

const crypto  = require('crypto');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { syncItemByPlaidId } = require('../plaidDailySync');
const { sendApnsNotification, isApnsConfigured } = require('../lib/apns-sender');

// ── Plaid webhook signature verification ────────────────────────────────────
// Plaid signs each webhook with an ES256 JWT in the Plaid-Verification header.
// The JWT payload contains request_body_sha256 — the SHA-256 of the raw body.
// Keys are fetched from Plaid's webhook_verification_key/get endpoint and
// cached by kid so we make at most one round-trip per new key rotation.

// Keys expire after 24h so a Plaid key rotation is picked up within a day
// even if no JWT verify failure forces early eviction.
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const keyCache = new Map(); // kid → { key: KeyObject, ts: number }

function plaidBaseUrl() {
  return process.env.PLAID_ENV === 'sandbox'
    ? 'https://sandbox.plaid.com'
    : 'https://production.plaid.com';
}

async function fetchPlaidKey(kid) {
  const cached = keyCache.get(kid);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL_MS) return cached.key;

  const res = await fetch(`${plaidBaseUrl()}/webhook_verification_key/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret:    process.env.PLAID_SECRET,
      key_id:    kid,
    }),
  });
  if (!res.ok) throw new Error(`Plaid key fetch ${res.status}`);
  const { key } = await res.json();
  if (!key) throw new Error('Plaid key missing in response');
  const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
  keyCache.set(kid, { key: publicKey, ts: Date.now() });
  return publicKey;
}

async function verifyPlaidSignature(req) {
  const token = req.headers['plaid-verification'];
  if (!token) throw new Error('Missing Plaid-Verification header');

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error('JWT missing kid');

  let publicKey;
  try {
    publicKey = await fetchPlaidKey(decoded.header.kid);
  } catch (e) {
    throw new Error(`Key fetch failed: ${e.message}`);
  }

  let payload;
  try {
    payload = jwt.verify(token, publicKey, { algorithms: ['ES256'] });
  } catch (e) {
    // Clear stale cache entry in case Plaid rotated the key
    keyCache.delete(decoded.header.kid);
    throw new Error(`JWT verify failed: ${e.message}`);
  }

  // rawBody must be set by express.json()'s verify callback — if it's missing,
  // something changed in the middleware stack and we must not silently pass.
  if (!req.rawBody) throw new Error('rawBody unavailable — verify callback missing from express.json()');
  const bodyHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  if (payload.request_body_sha256 !== bodyHash) throw new Error('Body hash mismatch');

  // Reject stale webhooks (Plaid recommends a 5-minute window)
  if (Math.floor(Date.now() / 1000) - payload.iat > 300) throw new Error('Webhook too old');
}

// ── Route ───────────────────────────────────────────────────────────────────

module.exports = function (pool) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    // Verify signature before doing anything else.
    // Skip in non-production when Plaid creds are absent (local dev without Plaid).
    if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
      try {
        await verifyPlaidSignature(req);
      } catch (err) {
        console.warn('[plaid-webhook] Signature rejected:', err.message);
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    res.status(200).send('ok');

    const { webhook_type, webhook_code, item_id } = req.body || {};
    if (webhook_type !== 'TRANSACTIONS' || !item_id) return;
    if (!['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(webhook_code)) return;

    handleWebhookAsync(pool, item_id).catch(err =>
      console.error('[plaid-webhook]', err.message)
    );
  });

  return router;
};

// ── Async notification handler ───────────────────────────────────────────────

async function handleWebhookAsync(pool, item_id) {
  const { userId, added } = await syncItemByPlaidId(pool, item_id);
  if (!added || added < 1 || !userId) return;

  const txRes = await pool.query(
    `SELECT description, merchant_name, amount
     FROM plaid_transactions
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '5 minutes'
       AND is_pending = false
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!txRes.rows.length) return;

  const tx = txRes.rows[0];
  const merchant = tx.merchant_name || tx.description || 'a merchant';
  const dollars = parseFloat(tx.amount);

  const rateRes = await pool.query('SELECT hourly_rate FROM users WHERE id = $1', [userId]);
  const hourlyRate = parseFloat(rateRes.rows[0]?.hourly_rate || 0);
  const hoursCtx = hourlyRate > 0 ? ` · ${(dollars / hourlyRate).toFixed(1)}h of work` : '';

  const title = 'New transaction';
  const body = `$${dollars.toFixed(2)} at ${merchant}${hoursCtx} — tap to review`;

  // Web Push
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails('mailto:hello@focusledger.net', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const subs = await pool.query(
        'SELECT subscription, endpoint FROM push_subscriptions WHERE user_id = $1 AND enabled = true',
        [userId]
      );
      const payload = JSON.stringify({ title, body, url: '/money', tag: 'fl-spend', renotify: true });
      for (const row of subs.rows) {
        const sub = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
        webpush.sendNotification(sub, payload).catch(e => {
          if (e.statusCode === 410 || e.statusCode === 404) {
            pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]).catch(e => console.warn('[plaid-webhook] cleanup push_subscriptions:', e.message));
          }
        });
      }
    } catch {}
  }

  // APNs
  if (isApnsConfigured()) {
    const tokenRows = await pool.query('SELECT token FROM push_tokens WHERE user_id = $1', [userId]);
    const tokens = tokenRows.rows.map(r => r.token);
    if (tokens.length) {
      await sendApnsNotification(tokens, { title, body, url: '/money' }, (bad) =>
        pool.query('DELETE FROM push_tokens WHERE token = $1', [bad]).catch(e => console.warn('[plaid-webhook] cleanup push_tokens:', e.message))
      );
    }
  }
}
