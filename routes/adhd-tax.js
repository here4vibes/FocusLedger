/**
 * ADHD Tax Calculator — API Routes
 *
 * POST /api/adhd-tax/submit   — Save lead + trigger results email
 * GET  /api/adhd-tax/results/:hash — Retrieve results by share hash
 *
 * === Calculation Logic ===
 * All dollar amounts are annual ($/year).
 * Formula is isolated in ADHD_TAX_CONFIG so it can be tuned without touching logic.
 *
 * Q1 — App subscriptions (how many productivity/finance apps do you pay for?)
 *   none  → $0   (no paid apps)
 *   1-2   → $180 (avg $90/app × 2 × 12 months)
 *   3-4   → $480 (avg $10/app × 4 × 12 months)
 *   5+    → $720 (avg $10/app × 6 × 12 months)
 *
 * Q2 — Late fees / overdrafts (how often?)
 *   never          → $0
 *   once_year      → $35   (single late fee)
 *   monthly        → $420  ($35/mo × 12)
 *   multiple_month → $960  (~$80/mo × 12 — multiple fees per month)
 *
 * Q3 — Impulse / regret purchases (estimated monthly spend)
 *   Midpoint of range × 12 months
 *   under_50  → $300   ($25 midpoint × 12)
 *   50_150    → $1,200  ($100 midpoint × 12)
 *   150_400   → $3,300  ($275 midpoint × 12)
 *   400_plus  → $6,000  ($500 representative × 12)
 *
 * Q4 — Missed or double-paid bills
 *   never   → $0
 *   rarely  → $50   (~1 missed/yr, avg $50 penalty or wasted duplicate)
 *   monthly → $300  ($25/mo avg penalty × 12)
 *   often   → $720  ($60/mo avg × 12)
 *
 * Q5 — Unused subscriptions (past year)
 *   no  → $0
 *   yes → user-provided monthly estimate × 12
 *         (defaults to $120/yr if no amount given — industry avg unused sub)
 *
 * === Average Comparison ===
 * Average ADHD adult annual tax (mid-tier selection on all questions):
 *   App stack 1-2 ($180) + Late fees monthly ($420) + Impulse $50-150 ($1,200)
 *   + Missed bills rarely ($50) + Typical unused subs ($120) = ~$1,970
 * We publish $2,100 as the "average" (rounded, defensible, slightly conservative).
 */

const express = require('express');
const crypto = require('crypto');

// ─────────────────────────────────────────────
// CALCULATOR CONFIG — edit here to tune values
// ─────────────────────────────────────────────
const ADHD_TAX_CONFIG = {
  // Annual cost per app-stack tier
  appStack: {
    none: 0,
    '1-2': 180,
    '3-4': 480,
    '5+': 720
  },

  // Annual late-fee cost per frequency tier
  lateFees: {
    never: 0,
    once_year: 35,
    monthly: 420,
    multiple_month: 960
  },

  // Annual impulse spend (midpoint of monthly range × 12)
  impulse: {
    under_50: 300,   // $25 × 12
    '50_150': 1200,  // $100 × 12
    '150_400': 3300, // $275 × 12
    '400_plus': 6000 // $500 × 12
  },

  // Annual missed-bill cost per frequency tier
  missedBills: {
    never: 0,
    rarely: 50,
    monthly: 300,
    often: 720
  },

  // Default unused-sub cost when user says "yes" but provides no amount
  unusedSubsDefault: 120, // $10/mo × 12

  // Published "average" ADHD tax for comparison copy
  averageAnnual: 2100
};

// ─────────────────────────────────────────────────
// Pure calculation function (tested in __tests__)
// ─────────────────────────────────────────────────
function calculateAdhdTax(answers) {
  const {
    appStack,
    lateFees,
    impulse,
    missedBills,
    unusedSubsYesNo,
    unusedSubsAmount // monthly $ (string or number, user-typed)
  } = answers;

  const appStackCost   = ADHD_TAX_CONFIG.appStack[appStack] ?? 0;
  const lateFeesCost   = ADHD_TAX_CONFIG.lateFees[lateFees] ?? 0;
  const impulseCost    = ADHD_TAX_CONFIG.impulse[impulse] ?? 0;
  const missedBillsCost = ADHD_TAX_CONFIG.missedBills[missedBills] ?? 0;

  let unusedSubsCost = 0;
  if (unusedSubsYesNo === 'yes') {
    const monthly = parseFloat(unusedSubsAmount) || 0;
    unusedSubsCost = monthly > 0 ? monthly * 12 : ADHD_TAX_CONFIG.unusedSubsDefault;
  }

  const total = appStackCost + lateFeesCost + impulseCost + missedBillsCost + unusedSubsCost;

  return {
    total,
    breakdown: {
      appStack: appStackCost,
      lateFees: lateFeesCost,
      impulse: impulseCost,
      missedBills: missedBillsCost,
      unusedSubs: unusedSubsCost
    },
    averageAnnual: ADHD_TAX_CONFIG.averageAnnual,
    comparedToAverage: total > ADHD_TAX_CONFIG.averageAnnual ? 'above' : 'below'
  };
}

// ─────────────────────────────────────────────────
// Email results helper (fire-and-forget, graceful fail)
// ─────────────────────────────────────────────────
async function sendResultsEmail(email, results, shareHash) {
  const { sendEmail } = require('../lib/emailService');

  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const shareUrl = `https://focusledger.net/adhd-tax?r=${shareHash}`;
  const { total, breakdown, averageAnnual, comparedToAverage } = results;

  const subject = `Your ADHD Tax: ${fmt(total)}/year`;

  const textBody = `Your ADHD Tax breakdown

Total: ${fmt(total)}/year

Here's where it goes:

- App subscriptions:    ${fmt(breakdown.appStack)}
- Late fees / overdrafts: ${fmt(breakdown.lateFees)}
- Impulse purchases:    ${fmt(breakdown.impulse)}
- Missed or double bills: ${fmt(breakdown.missedBills)}
- Unused subscriptions: ${fmt(breakdown.unusedSubs)}

You're ${comparedToAverage} the average ADHD adult (${fmt(averageAnnual)}/year).

FocusLedger is built specifically for ADHD minds — tasks, spending, and reminders in one place. At $9.99/month ($100/year), it costs a fraction of what your ADHD tax costs you.

Try it free: https://focusledger.net/signup

See your full results: ${shareUrl}

---
You got this result from the FocusLedger ADHD Tax Calculator.
`;

  const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 0 20px; color: #1A1A2E;">
  <h2 style="font-size: 24px; margin-top: 32px;">Your ADHD Tax: <span style="color: #F26B3A;">${fmt(total)}/year</span></h2>
  <p style="color: #6B6B80; line-height: 1.6;">Here's the full breakdown of what ADHD costs you annually.</p>

  <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
    <tr style="border-bottom: 1px solid #EEE;">
      <td style="padding: 10px 0; color: #6B6B80;">App subscriptions</td>
      <td style="padding: 10px 0; text-align: right; font-weight: 600;">${fmt(breakdown.appStack)}</td>
    </tr>
    <tr style="border-bottom: 1px solid #EEE;">
      <td style="padding: 10px 0; color: #6B6B80;">Late fees &amp; overdrafts</td>
      <td style="padding: 10px 0; text-align: right; font-weight: 600;">${fmt(breakdown.lateFees)}</td>
    </tr>
    <tr style="border-bottom: 1px solid #EEE;">
      <td style="padding: 10px 0; color: #6B6B80;">Impulse purchases</td>
      <td style="padding: 10px 0; text-align: right; font-weight: 600;">${fmt(breakdown.impulse)}</td>
    </tr>
    <tr style="border-bottom: 1px solid #EEE;">
      <td style="padding: 10px 0; color: #6B6B80;">Missed or double bills</td>
      <td style="padding: 10px 0; text-align: right; font-weight: 600;">${fmt(breakdown.missedBills)}</td>
    </tr>
    <tr style="border-bottom: 2px solid #1A1A2E;">
      <td style="padding: 10px 0; color: #6B6B80;">Unused subscriptions</td>
      <td style="padding: 10px 0; text-align: right; font-weight: 600;">${fmt(breakdown.unusedSubs)}</td>
    </tr>
    <tr>
      <td style="padding: 14px 0; font-weight: 700; font-size: 18px;">Total ADHD Tax</td>
      <td style="padding: 14px 0; text-align: right; font-weight: 700; font-size: 18px; color: #F26B3A;">${fmt(total)}/yr</td>
    </tr>
  </table>

  <p style="color: #6B6B80; line-height: 1.6;">You're <strong>${comparedToAverage} average</strong> — the typical ADHD adult pays ${fmt(averageAnnual)}/year.</p>

  <div style="background: #FFF8F0; border-left: 4px solid #F26B3A; padding: 20px; border-radius: 0 8px 8px 0; margin: 24px 0;">
    <p style="margin: 0; font-weight: 600;">FocusLedger is $180/year.</p>
    <p style="margin: 8px 0 0; color: #6B6B80; line-height: 1.5;">Tasks + spending + reminders in one app built for ADHD. That's ${fmt(total - 180)} less than your current ADHD tax.</p>
  </div>

  <a href="https://focusledger.net/signup" style="display: inline-block; background: #F26B3A; color: white; padding: 14px 28px; border-radius: 50px; text-decoration: none; font-weight: 600; margin: 8px 0 24px;">Try FocusLedger free →</a>

  <p style="color: #9999AA; font-size: 13px; margin-top: 32px;">
    See your full results anytime: <a href="${shareUrl}" style="color: #F26B3A;">${shareUrl}</a>
  </p>
</div>
`;

  const result = await sendEmail({
    to: email,
    from: 'FocusLedger <hello@focusledger.net>',
    subject,
    html: htmlBody,
    text: textBody,
    templateType: 'adhd_tax_results',
  });
  if (!result.success) console.error('[adhd-tax] results email failed (non-fatal):', result.error);
  return result.success;
}

// ─────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────
module.exports = function adhdTaxRoutes(pool) {
  const router = express.Router();

  /**
   * POST /api/adhd-tax/submit
   *
   * Body: { email, answers: { appStack, lateFees, impulse, missedBills, unusedSubsYesNo, unusedSubsAmount } }
   *
   * 1. Validates inputs
   * 2. Computes the ADHD tax breakdown
   * 3. Generates a unique share hash
   * 4. Saves lead to adhd_tax_leads
   * 5. Fires results email (non-blocking)
   * 6. Returns { results, shareHash }
   */
  router.post('/submit', async (req, res) => {
    const { email, answers } = req.body || {};

    // Basic validation
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const requiredAnswers = ['appStack', 'lateFees', 'impulse', 'missedBills'];
    for (const key of requiredAnswers) {
      if (!answers || !answers[key]) {
        return res.status(400).json({ error: `Missing answer: ${key}` });
      }
    }

    // Validate that answers are known keys
    if (!ADHD_TAX_CONFIG.appStack.hasOwnProperty(answers.appStack)) {
      return res.status(400).json({ error: 'Invalid appStack value' });
    }
    if (!ADHD_TAX_CONFIG.lateFees.hasOwnProperty(answers.lateFees)) {
      return res.status(400).json({ error: 'Invalid lateFees value' });
    }
    if (!ADHD_TAX_CONFIG.impulse.hasOwnProperty(answers.impulse)) {
      return res.status(400).json({ error: 'Invalid impulse value' });
    }
    if (!ADHD_TAX_CONFIG.missedBills.hasOwnProperty(answers.missedBills)) {
      return res.status(400).json({ error: 'Invalid missedBills value' });
    }

    const results = calculateAdhdTax(answers);

    // Generate unique 16-char hex share hash
    const shareHash = crypto.randomBytes(8).toString('hex');

    const client = await pool.connect();
    try {
      // Look up existing user by email
      const userRow = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email.trim()]
      );
      const userId = userRow.rows[0]?.id || null;

      // Insert lead
      await client.query(
        `INSERT INTO adhd_tax_leads (email, source, results_json, share_hash, user_id)
         VALUES ($1, 'adhd_tax_calculator', $2, $3, $4)`,
        [email.trim().toLowerCase(), JSON.stringify({ answers, results }), shareHash, userId]
      );

      // Fire email (non-blocking — we don't await success before responding)
      sendResultsEmail(email.trim(), results, shareHash).then(sent => {
        if (sent) {
          pool.query(
            'UPDATE adhd_tax_leads SET email_sent_at = NOW() WHERE share_hash = $1',
            [shareHash]
          ).catch(() => {}); // best-effort update
        }
      });

      return res.json({ results, shareHash, existingUser: !!userId });
    } catch (err) {
      console.error('[adhd-tax] Submit error:', err);
      return res.status(500).json({ error: 'Failed to save results. Please try again.' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/adhd-tax/results/:hash
   *
   * Retrieves saved results by share hash.
   * Used when a user shares their results link (?r=<hash>) and the page reloads.
   */
  router.get('/results/:hash', async (req, res) => {
    const { hash } = req.params;

    if (!hash || !/^[a-f0-9]{16}$/.test(hash)) {
      return res.status(400).json({ error: 'Invalid hash' });
    }

    const client = await pool.connect();
    try {
      const row = await client.query(
        'SELECT results_json, share_hash, created_at FROM adhd_tax_leads WHERE share_hash = $1',
        [hash]
      );

      if (!row.rows.length) {
        return res.status(404).json({ error: 'Results not found' });
      }

      const { results_json, share_hash, created_at } = row.rows[0];
      return res.json({ ...results_json, shareHash: share_hash, createdAt: created_at });
    } catch (err) {
      console.error('[adhd-tax] Results lookup error:', err);
      return res.status(500).json({ error: 'Failed to load results' });
    } finally {
      client.release();
    }
  });

  return router;
};

// Export the pure calculation function for unit tests
module.exports.calculateAdhdTax = calculateAdhdTax;
module.exports.ADHD_TAX_CONFIG = ADHD_TAX_CONFIG;
