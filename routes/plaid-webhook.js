'use strict';

const express = require('express');
const { syncItemByPlaidId } = require('../plaidDailySync');
const { sendApnsNotification, isApnsConfigured } = require('../lib/apns-sender');

module.exports = function (pool) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    res.status(200).send('ok');

    const { webhook_type, webhook_code, item_id } = req.body || {};
    if (webhook_type !== 'TRANSACTIONS' || !item_id) return;
    if (!['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE'].includes(webhook_code)) return;

    handleWebhookAsync(pool, item_id).catch(err =>
      console.error('[plaid-webhook]', err.message)
    );
  });

  return router;
};

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

  // Fetch user's hourly rate to show hours-of-work context
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
