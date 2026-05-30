// Owns: insurance policy CRUD, coverage gap detection, Plaid bank feed inference.
// Does NOT own: document storage, user auth, subscription gating logic, or Plaid sync.
//
// Endpoints:
//   GET    /api/insurance             — list user's policies + coverage summary
//   POST   /api/insurance             — create policy
//   PATCH  /api/insurance/:id         — update policy
//   DELETE /api/insurance/:id         — delete policy
//   GET    /api/insurance/infer       — scan Plaid transactions for insurance payments
//   POST   /api/insurance/infer/confirm — confirm an inferred policy suggestion

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// Insurance types an adult typically needs — used for gap detection
const COVERAGE_TYPES = ['auto', 'renters', 'health', 'life'];

// Known insurer name patterns → policy type inference from Plaid transactions
const INSURER_PATTERNS = [
  { pattern: /geico/i,                     type: 'auto',     label: 'GEICO' },
  { pattern: /state\s*farm/i,              type: 'auto',     label: 'State Farm' },
  { pattern: /progressive/i,               type: 'auto',     label: 'Progressive' },
  { pattern: /allstate/i,                  type: 'auto',     label: 'Allstate' },
  { pattern: /liberty\s*mutual/i,          type: 'auto',     label: 'Liberty Mutual' },
  { pattern: /usaa/i,                      type: 'auto',     label: 'USAA' },
  { pattern: /nationwide/i,                type: 'auto',     label: 'Nationwide' },
  { pattern: /travelers/i,                 type: 'auto',     label: 'Travelers' },
  { pattern: /aetna/i,                     type: 'health',   label: 'Aetna' },
  { pattern: /blue\s*cross|bcbs/i,         type: 'health',   label: 'Blue Cross' },
  { pattern: /united\s*health(care)?/i,    type: 'health',   label: 'UnitedHealthcare' },
  { pattern: /cigna/i,                     type: 'health',   label: 'Cigna' },
  { pattern: /humana/i,                    type: 'health',   label: 'Humana' },
  { pattern: /kaiser/i,                    type: 'health',   label: 'Kaiser Permanente' },
  { pattern: /anthem/i,                    type: 'health',   label: 'Anthem' },
  { pattern: /molina/i,                    type: 'health',   label: 'Molina Healthcare' },
  { pattern: /metlife/i,                   type: 'life',     label: 'MetLife' },
  { pattern: /new\s*york\s*life/i,         type: 'life',     label: 'New York Life' },
  { pattern: /northwest(ern)?\s*mutual/i,  type: 'life',     label: 'Northwestern Mutual' },
  { pattern: /prudential/i,               type: 'life',     label: 'Prudential' },
  { pattern: /lincoln\s*(financial|benefit)/i, type: 'life', label: 'Lincoln Financial' },
  { pattern: /principal\s*(financial|life)/i,  type: 'life', label: 'Principal Financial' },
  { pattern: /lemonade/i,                  type: 'renters',  label: 'Lemonade' },
  { pattern: /renters.*insurance/i,        type: 'renters',  label: 'Renters Insurance' },
];

// Coverage gap friendly labels
const GAP_LABELS = {
  auto:    { title: 'Auto insurance', icon: '🚗', desc: 'Required in most states.' },
  renters: { title: 'Renters insurance', icon: '🏠', desc: 'Covers your belongings and liability.' },
  health:  { title: 'Health insurance', icon: '🏥', desc: 'Covers medical expenses.' },
  life:    { title: 'Life insurance', icon: '🛡️', desc: 'Protects your dependents.' },
};

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── GET /api/insurance ────────────────────────────────────────────────────
  // Returns policies + coverage gap status for the dashboard.
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT ip.id, ip.type, ip.provider, ip.policy_number,
               ip.coverage_amount, ip.premium_monthly, ip.expiry_date,
               ip.document_id, ip.notes, ip.inferred_from_plaid, ip.plaid_merchant,
               ip.created_at, ip.updated_at,
               d.name AS document_name
        FROM insurance_policies ip
        LEFT JOIN documents d ON d.id = ip.document_id
        WHERE ip.user_id = $1
        ORDER BY ip.type, ip.created_at DESC
      `, [userId]);

      const policies = result.rows;

      // Compute coverage gap status
      const coveredTypes = new Set(policies.map(p => p.type.toLowerCase()));
      const coverage = COVERAGE_TYPES.map(type => ({
        type,
        ...GAP_LABELS[type],
        covered: coveredTypes.has(type),
        policy: policies.find(p => p.type.toLowerCase() === type) || null,
      }));

      res.json({ success: true, policies, coverage });
    } catch (err) {
      console.error('[insurance] list error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load policies.' });
    }
  });

  // ─── POST /api/insurance ───────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { type, provider, policy_number, coverage_amount, premium_monthly,
              expiry_date, document_id, notes } = req.body;

      if (!type) {
        return res.status(400).json({ success: false, message: 'type is required.' });
      }

      const result = await pool.query(`
        INSERT INTO insurance_policies
          (user_id, type, provider, policy_number, coverage_amount,
           premium_monthly, expiry_date, document_id, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, type, provider, policy_number, coverage_amount,
                  premium_monthly, expiry_date, document_id, notes, created_at
      `, [
        userId,
        type,
        provider || null,
        policy_number || null,
        coverage_amount || null,
        premium_monthly || null,
        expiry_date || null,
        document_id || null,
        notes || null,
      ]);

      res.json({ success: true, policy: result.rows[0] });
    } catch (err) {
      console.error('[insurance] create error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save policy.' });
    }
  });

  // ─── PATCH /api/insurance/:id ──────────────────────────────────────────────
  router.patch('/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const { type, provider, policy_number, coverage_amount, premium_monthly,
              expiry_date, document_id, notes } = req.body;

      const result = await pool.query(`
        UPDATE insurance_policies
        SET type             = COALESCE($1, type),
            provider         = COALESCE($2, provider),
            policy_number    = COALESCE($3, policy_number),
            coverage_amount  = $4,
            premium_monthly  = $5,
            expiry_date      = $6,
            document_id      = $7,
            notes            = COALESCE($8, notes),
            updated_at       = NOW()
        WHERE id = $9 AND user_id = $10
        RETURNING id, type, provider, policy_number, coverage_amount,
                  premium_monthly, expiry_date, document_id, notes, updated_at
      `, [
        type || null,
        provider || null,
        policy_number || null,
        coverage_amount !== undefined ? coverage_amount : null,
        premium_monthly !== undefined ? premium_monthly : null,
        expiry_date !== undefined ? (expiry_date || null) : null,
        document_id !== undefined ? (document_id || null) : null,
        notes || null,
        req.params.id,
        userId,
      ]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Policy not found.' });
      }
      res.json({ success: true, policy: result.rows[0] });
    } catch (err) {
      console.error('[insurance] update error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update policy.' });
    }
  });

  // ─── DELETE /api/insurance/:id ─────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM insurance_policies WHERE id = $1 AND user_id = $2 RETURNING id',
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Policy not found.' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[insurance] delete error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to delete policy.' });
    }
  });

  // ─── GET /api/insurance/infer ──────────────────────────────────────────────
  // Scan the user's Plaid transactions for known insurer patterns.
  // Returns suggested policies NOT already in insurance_policies.
  // User must confirm before a record is created.
  router.get('/infer', async (req, res) => {
    try {
      const userId = req.user.id;

      // Check if user has any Plaid data at all
      const plaidCheck = await pool.query(
        'SELECT COUNT(*) FROM plaid_items WHERE user_id = $1',
        [userId]
      );
      if (parseInt(plaidCheck.rows[0].count, 10) === 0) {
        return res.json({ success: true, suggestions: [], has_plaid: false });
      }

      // Pull recent Plaid transactions (last 90 days) — confirmed + pending review
      const txResult = await pool.query(`
        SELECT DISTINCT ON (merchant_name)
          id, merchant_name, description, amount, transaction_date
        FROM plaid_transactions
        WHERE user_id = $1
          AND transaction_date >= NOW() - INTERVAL '90 days'
          AND amount > 0
        ORDER BY merchant_name, transaction_date DESC
      `, [userId]);

      // Get user's existing policy providers to avoid duplicate suggestions
      const existingResult = await pool.query(
        'SELECT LOWER(provider) AS provider FROM insurance_policies WHERE user_id = $1 AND provider IS NOT NULL',
        [userId]
      );
      const existingProviders = new Set(existingResult.rows.map(r => r.provider));

      const suggestions = [];
      const seen = new Set(); // deduplicate by inferred label

      for (const tx of txResult.rows) {
        const name = tx.merchant_name || tx.description || '';
        for (const p of INSURER_PATTERNS) {
          if (p.pattern.test(name)) {
            const key = p.label.toLowerCase();
            if (seen.has(key)) continue;
            // Skip if user already has this provider
            if (existingProviders.has(key)) continue;
            seen.add(key);
            suggestions.push({
              merchant_name: name,
              inferred_type: p.type,
              inferred_provider: p.label,
              amount: tx.amount,
              transaction_date: tx.transaction_date,
              monthly_estimate: tx.amount, // assume monthly; user can correct
            });
            break;
          }
        }
      }

      res.json({ success: true, suggestions, has_plaid: true });
    } catch (err) {
      console.error('[insurance] infer error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to scan transactions.' });
    }
  });

  // ─── POST /api/insurance/infer/confirm ────────────────────────────────────
  // User confirms a suggestion → create the policy record.
  router.post('/infer/confirm', async (req, res) => {
    try {
      const userId = req.user.id;
      const { type, provider, premium_monthly, merchant_name } = req.body;

      if (!type) {
        return res.status(400).json({ success: false, message: 'type is required.' });
      }

      const result = await pool.query(`
        INSERT INTO insurance_policies
          (user_id, type, provider, premium_monthly, inferred_from_plaid, plaid_merchant)
        VALUES ($1, $2, $3, $4, TRUE, $5)
        RETURNING id, type, provider, premium_monthly, inferred_from_plaid, plaid_merchant, created_at
      `, [
        userId,
        type,
        provider || null,
        premium_monthly || null,
        merchant_name || null,
      ]);

      res.json({ success: true, policy: result.rows[0] });
    } catch (err) {
      console.error('[insurance] confirm infer error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save policy.' });
    }
  });

  return router;
};
