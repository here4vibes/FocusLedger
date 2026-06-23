// Phase 3B: Plaid integration backed by pg.Pool (Prisma removed).
// Owns: Plaid Link flow, token exchange, transaction sync, bill detection, task matching.
// Does NOT own: auth middleware, expense CRUD (routes/money-prisma.js).
const express = require('express');
const crypto = require('crypto');
const { checkProStatus } = require('../middleware/proUtils');

// ── Auth: session cookie (fl_sid) OR Bearer JWT ──────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) { req.user = req.session.user; return next(); }
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    const { verifyToken } = require('../middleware/auth');
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

const {
  upsertPlaidItem,
  deletePlaidItem,
  updateItemCursor,
  upsertPlaidAccount,
  getAccountMap,
  getCategoriesMap,
  insertPlaidTransaction,
  trackBillMerchant,
  getDisabledMerchantKeys,
} = require('../db/money-prisma');

// ── Token encryption (AES-256-GCM) ──────────────────────────────────────────
const _plaidEncKey = Buffer.from(
  crypto.createHash('sha256')
    .update(process.env.PLAID_ENCRYPTION_KEY || process.env.JWT_SECRET || 'focusledger-plaid-enc')
    .digest('hex'),
  'hex'
).subarray(0, 32);

function encryptPlaidToken(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _plaidEncKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptPlaidToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const data = Buffer.from(ciphertext, 'base64');
    if (data.length < 29) return ciphertext;
    const iv  = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const enc = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _plaidEncKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext;
  }
}

// ── Category classification ─────────────────────────────────────────────────
const PLAID_CATEGORY_MAP = {
  GROCERIES:                   'Groceries',
  FOOD_AND_DRINK:              'Food & Dining',
  RESTAURANTS:                 'Food & Dining',
  TRANSPORTATION:              'Transport',
  TRAVEL:                      'Transport',
  GENERAL_MERCHANDISE:         'Shopping',
  CLOTHING_AND_ACCESSORIES:    'Shopping',
  ONLINE_MARKETPLACES:         'Shopping',
  SPORTING_GOODS:              'Shopping',
  HOBBY:                       'Shopping',
  GIFTS_AND_DONATIONS:        'Shopping',
  UTILITIES:                  'Bills & Utilities',
  BILL_PAYMENTS:              'Bills & Utilities',
  RENT_AND_UTILITIES:         'Bills & Utilities',
  HOME_IMPROVEMENT:            'Bills & Utilities',
  LOAN_PAYMENTS:              'Bills & Utilities',
  BANK_FEES:                  'Bills & Utilities',
  ENTERTAINMENT:              'Entertainment',
  RECREATION:                 'Entertainment',
  SPORTS:                     'Entertainment',
  MEDICAL:                    'Health',
  PERSONAL_CARE:               'Health',
  FITNESS:                    'Health',
};

const LEGACY_CATEGORY_MAP = {
  'Food and Drink':             'Food & Dining',
  'Supermarkets and Groceries': 'Groceries',
  'Travel':                    'Transport',
  'Shops':                     'Shopping',
  'Recreation':               'Entertainment',
  'Healthcare':                'Health',
  'Service':                   'Bills & Utilities',
  'Payment':                   'Bills & Utilities',
};

const BILL_PLAID_CATEGORIES = new Set([
  'UTILITIES', 'BILL_PAYMENTS', 'RENT_AND_UTILITIES',
  'LOAN_PAYMENTS', 'INSURANCE', 'SUBSCRIPTION', 'RENT',
]);

const BILL_MERCHANT_PATTERNS = [
  { pattern: /netflix/i, type: 'subscription', label: 'Netflix' },
  { pattern: /spotify/i, type: 'subscription', label: 'Spotify' },
  { pattern: /hulu/i, type: 'subscription', label: 'Hulu' },
  { pattern: /disney+?/i, type: 'subscription', label: 'Disney+' },
  { pattern: /apple.*(tv|music|one)/i, type: 'subscription', label: 'Apple Subscription' },
  { pattern: /amazon.*(prime|video)/i, type: 'subscription', label: 'Amazon Prime' },
  { pattern: /youtube.*premium/i, type: 'subscription', label: 'YouTube Premium' },
  { pattern: /hbo|max\b/i, type: 'subscription', label: 'HBO Max' },
  { pattern: /paramount/i, type: 'subscription', label: 'Paramount+' },
  { pattern: /peacock/i, type: 'subscription', label: 'Peacock' },
  { pattern: /adobe/i, type: 'subscription', label: 'Adobe' },
  { pattern: /microsoft *(365|office)/i, type: 'subscription', label: 'Microsoft 365' },
  { pattern: /dropbox/i, type: 'subscription', label: 'Dropbox' },
  { pattern: /icloud/i, type: 'subscription', label: 'iCloud' },
  { pattern: /google *(one|workspace)/i, type: 'subscription', label: 'Google One' },
  { pattern: /sirius.*xm|siriusxm/i, type: 'subscription', label: 'SiriusXM' },
  { pattern: /audible/i, type: 'subscription', label: 'Audible' },
  { pattern: /con *ed|consolidated *edison/i, type: 'utility', label: 'Con Edison' },
  { pattern: /pge|pacific *gas/i, type: 'utility', label: 'PG&E' },
  { pattern: /duke *energy/i, type: 'utility', label: 'Duke Energy' },
  { pattern: /dominion *energy/i, type: 'utility', label: 'Dominion Energy' },
  { pattern: /xcel *energy/i, type: 'utility', label: 'Xcel Energy' },
  { pattern: /national *grid/i, type: 'utility', label: 'National Grid' },
  { pattern: /eversource/i, type: 'utility', label: 'Eversource' },
  { pattern: /pepco|potomac *electric/i, type: 'utility', label: 'PEPCO' },
  { pattern: /nicor *gas/i, type: 'utility', label: 'Nicor Gas' },
  { pattern: /national *fuel/i, type: 'utility', label: 'National Fuel Gas' },
  { pattern: /water *(authority|service|works|dept|utility)/i, type: 'utility', label: 'Water Utility' },
  { pattern: /american *water/i, type: 'utility', label: 'American Water' },
  { pattern: /verizon/i, type: 'utility', label: 'Verizon' },
  { pattern: /at&t|\batatt\b/i, type: 'utility', label: 'AT&T' },
  { pattern: /t.?mobile/i, type: 'utility', label: 'T-Mobile' },
  { pattern: /comcast|xfinity/i, type: 'utility', label: 'Comcast/Xfinity' },
  { pattern: /spectrum/i, type: 'utility', label: 'Spectrum' },
  { pattern: /cox *communications/i, type: 'utility', label: 'Cox' },
  { pattern: /centurylink|lumen/i, type: 'utility', label: 'CenturyLink' },
  { pattern: /geico/i, type: 'insurance', label: 'GEICO' },
  { pattern: /state *farm/i, type: 'insurance', label: 'State Farm' },
  { pattern: /progressive/i, type: 'insurance', label: 'Progressive' },
  { pattern: /allstate/i, type: 'insurance', label: 'Allstate' },
  { pattern: /liberty *mutual/i, type: 'insurance', label: 'Liberty Mutual' },
  { pattern: /usaa/i, type: 'insurance', label: 'USAA' },
  { pattern: /aetna/i, type: 'insurance', label: 'Aetna' },
  { pattern: /blue *cross|bcbs/i, type: 'insurance', label: 'Blue Cross' },
  { pattern: /united *health(care)?/i, type: 'insurance', label: 'UnitedHealthcare' },
  { pattern: /cigna/i, type: 'insurance', label: 'Cigna' },
  { pattern: /humana/i, type: 'insurance', label: 'Humana' },
  { pattern: /rent *payment|property *management/i, type: 'rent', label: 'Rent Payment' },
  { pattern: /wells *fargo *mortgage/i, type: 'rent', label: 'Wells Fargo Mortgage' },
  { pattern: /chase *mortgage/i, type: 'rent', label: 'Chase Mortgage' },
  { pattern: /rocket *mortgage/i, type: 'rent', label: 'Rocket Mortgage' },
  { pattern: /student *loan|sallie *mae|navient/i, type: 'loan', label: 'Student Loan' },
  { pattern: /auto *loan|car *payment/i, type: 'loan', label: 'Car Payment' },
];

function normalizeMerchantKey(name) {
  return (name || '')
    .toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').substring(0, 100);
}

function detectBillType(tx) {
  if (tx.personal_finance_category) {
    const primary = tx.personal_finance_category.primary;
    if (BILL_PLAID_CATEGORIES.has(primary)) {
      if (primary === 'SUBSCRIPTION') return { type: 'subscription', label: null };
      if (primary === 'LOAN_PAYMENTS') return { type: 'loan', label: null };
      if (primary === 'INSURANCE') return { type: 'insurance', label: null };
      if (primary === 'RENT_AND_UTILITIES' || primary === 'UTILITIES') return { type: 'utility', label: null };
      if (primary === 'RENT') return { type: 'rent', label: null };
      return { type: 'other_bill', label: null };
    }
  }
  if (tx.category) {
    const catStr = tx.category.join(' ').toLowerCase();
    if (catStr.includes('subscription') || catStr.includes('recurring')) return { type: 'subscription', label: null };
    if (catStr.includes('utilities') || catStr.includes('electric') || catStr.includes('internet') || catStr.includes('phone')) return { type: 'utility', label: null };
    if (catStr.includes('insurance')) return { type: 'insurance', label: null };
    if (catStr.includes('rent') || catStr.includes('mortgage')) return { type: 'rent', label: null };
  }
  const merchantName = tx.merchant_name || tx.name || '';
  for (const p of BILL_MERCHANT_PATTERNS) {
    if (p.pattern.test(merchantName)) return { type: p.type, label: p.label };
  }
  return null;
}

function getBillTypeLabel(type) {
  const labels = { subscription: 'Subscription', utility: 'Utility', insurance: 'Insurance', rent: 'Rent/Mortgage', loan: 'Loan Payment', other_bill: 'Bill' };
  return labels[type] || 'Bill';
}

function classifyTransaction(transaction) {
  if (transaction.personal_finance_category) {
    const primary = transaction.personal_finance_category.primary;
    const detailed = transaction.personal_finance_category.detailed || '';
    if (primary === 'FOOD_AND_DRINK' && (detailed.includes('GROCERY') || detailed.includes('SUPERMARKET'))) return 'Groceries';
    if (PLAID_CATEGORY_MAP[primary]) return PLAID_CATEGORY_MAP[primary];
  }
  if (transaction.category && transaction.category.length > 0) {
    for (let i = transaction.category.length - 1; i >= 0; i--) {
      const cat = transaction.category[i];
      if (LEGACY_CATEGORY_MAP[cat]) return LEGACY_CATEGORY_MAP[cat];
    }
    const catStr = transaction.category.join(' ').toLowerCase();
    if (catStr.includes('grocer') || catStr.includes('supermarket')) return 'Groceries';
  }
  if (transaction.merchant_name) {
    const merchant = transaction.merchant_name.toLowerCase();
    if (merchant.includes('walmart') || merchant.includes('whole foods') || merchant.includes('trader joe') || merchant.includes('kroger') || merchant.includes('safeway') || merchant.includes('aldi') || merchant.includes('publix') || merchant.includes('costco')) return 'Groceries';
    if (merchant.includes('mcdonald') || merchant.includes('starbucks') || merchant.includes('chipotle') || merchant.includes('domino') || merchant.includes('subway') || merchant.includes('doordash') || merchant.includes('uber eats') || merchant.includes('grubhub')) return 'Food & Dining';
    if (merchant.includes('uber') || merchant.includes('lyft') || merchant.includes('delta') || merchant.includes('united airlines') || merchant.includes('american airlines')) return 'Transport';
    if (merchant.includes('amazon') || merchant.includes('target') || merchant.includes('ebay') || merchant.includes('etsy')) return 'Shopping';
    if (merchant.includes('netflix') || merchant.includes('spotify') || merchant.includes('hulu') || merchant.includes('disney') || (merchant.includes('apple') && merchant.includes('entertainment'))) return 'Entertainment';
    if (merchant.includes('cvs') || merchant.includes('walgreens') || merchant.includes('rite aid') || merchant.includes('pharmacy')) return 'Health';
  }
  return 'Other';
}

// Tracks which items have had their webhook URL registered this server session.
// Avoids a Plaid API call on every sync after the first registration.
const _webhookRegistered = new Set();

// ── Plaid client factory ────────────────────────────────────────────────────
function getPlaidClient() {
  // WHY trim: env vars set via dashboard UIs sometimes include trailing whitespace/newlines
  const clientId = (process.env.PLAID_CLIENT_ID || '').trim();
  const secret   = (process.env.PLAID_SECRET || '').trim();
  const plaidEnv = (process.env.PLAID_ENV || 'sandbox').trim();
  if (!clientId || !secret) return null;
  try {
    const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
    const basePath = PlaidEnvironments[plaidEnv];
    if (!basePath) {
      console.error(`[Plaid] Invalid PLAID_ENV="${plaidEnv}" — must be sandbox, development, or production`);
      return null;
    }
    const config = new Configuration({
      basePath,
      baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
    });
    return new PlaidApi(config);
  } catch (e) {
    console.error('[Plaid] Failed to initialize client:', e.message);
    return null;
  }
}

// ── Sync transactions ────────────────────────────────────────────────────────
async function syncTransactions(pool, item) {
  const plaid = getPlaidClient();
  if (!plaid) { console.error('[Plaid] syncTransactions: Plaid client not initialized — skipping'); return { added: 0, plaidReturned: 0, skippedCredit: 0, skippedNoAcct: 0, insertFailed: 0, accountMapSize: 0 }; }

  const accessToken = decryptPlaidToken(item.access_token);
  let cursor = item.cursor || null;
  let hasMore = true;
  let added = 0;
  let skippedCredit = 0;   // amount <= 0 (credits/refunds)
  let skippedNoAcct = 0;   // account_id not in accountMap
  let insertFailed = 0;    // insertPlaidTransaction returned null (DB error)
  let totalFromPlaid = 0;  // raw count of transactions Plaid returned across all pages
  const billCandidates = [];

  const accountMap = await getAccountMap(pool, item.id);
  const categoriesByName = await getCategoriesMap(pool);

  console.log(`[Plaid] syncTransactions start: item=${item.id} user=${item.user_id} cursor=${cursor ? 'set' : 'null (full)'} accountMapSize=${Object.keys(accountMap).length}`);
  if (Object.keys(accountMap).length === 0) {
    console.error('[Plaid] syncTransactions: accountMap is EMPTY for item', item.id, '— all transactions will be skipped. Check plaid_accounts rows.');
  }

  let lastSyncAccounts = [];
  while (hasMore) {
    const response = await plaid.transactionsSync({ access_token: accessToken, cursor: cursor || undefined, count: 100 });
    const { added: newTransactions, modified: modifiedTransactions = [], removed, next_cursor, has_more, accounts: syncAccounts } = response.data;
    if (syncAccounts && syncAccounts.length) lastSyncAccounts = syncAccounts;

    totalFromPlaid += newTransactions.length;
    console.log(`[Plaid] page: ${newTransactions.length} added, ${modifiedTransactions.length} modified, ${removed.length} removed, has_more=${has_more}`);

    for (const tx of newTransactions) {
      if (tx.amount <= 0) { skippedCredit++; continue; }
      const plaidAccountId = accountMap[tx.account_id];
      if (!plaidAccountId) {
        skippedNoAcct++;
        if (skippedNoAcct <= 3) {
          console.warn(`[Plaid] No accountMap entry for account_id=${tx.account_id} tx=${tx.transaction_id} — known accounts: ${Object.keys(accountMap).join(',')}`);
        }
        continue;
      }

      const categoryName = classifyTransaction(tx);
      const category = categoriesByName[categoryName.toLowerCase()] || categoriesByName['other'];
      const plaidCategoryStr = tx.personal_finance_category
        ? `${tx.personal_finance_category.primary}/${tx.personal_finance_category.detailed}`
        : (tx.category ? tx.category.join(' > ') : null);

      const plaidTx = await insertPlaidTransaction(pool, {
        plaidAccountId, userId: item.user_id, transactionId: tx.transaction_id,
        amount: tx.amount, description: tx.merchant_name || tx.name || 'Unknown',
        merchantName: tx.merchant_name || null, categoryId: category?.id || null,
        plaidCategory: plaidCategoryStr, transactionDate: tx.date, isPending: tx.pending || false,
      });

      // Auto-confirm non-pending transactions directly into expenses.
      // is_impulse stays NULL so the Buddy check-in flow asks impulse vs planned later.
      // Pending transactions (pre-auth holds) are staged only — confirmed when they clear.
      if (plaidTx && !tx.pending) {
        try {
          const expDate = String(tx.date).slice(0, 10);
          // Pre-check for duplicate to avoid ON CONFLICT (which requires a UNIQUE INDEX)
          let syncExpenseId = null;
          if (tx.transaction_id) {
            const { rows: dup } = await pool.query(
              'SELECT id FROM expenses WHERE plaid_transaction_id = $1 LIMIT 1',
              [tx.transaction_id]
            );
            syncExpenseId = dup[0]?.id || null;
          }
          if (!syncExpenseId) {
            const cols = ['user_id', 'amount', 'description', 'expense_date', 'source', 'plaid_transaction_id'];
            const vals = [item.user_id, parseFloat(tx.amount), tx.merchant_name || tx.name || 'Unknown', expDate, 'plaid', tx.transaction_id];
            if (plaidTx.category_id) { cols.push('category_id'); vals.push(plaidTx.category_id); }
            const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
            const { rows: expRows } = await pool.query(
              `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
              vals
            );
            syncExpenseId = expRows[0]?.id || null;
          }
          if (syncExpenseId) {
            await pool.query(
              'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
              [syncExpenseId, plaidTx.id]
            );
          }
        } catch (e) {
          console.error('[Plaid] Auto-confirm error for tx', plaidTx?.id, e.message);
        }
      }

      if (plaidTx) {
        added++;
        billCandidates.push({ ...tx, transaction_date: tx.date });
      } else {
        insertFailed++;
        if (insertFailed <= 3) {
          console.warn('[Plaid] insertPlaidTransaction returned null for tx', tx.transaction_id, '(isPending:', tx.pending, ') — check error above');
        }
      }
    }

    for (const removedTx of removed) {
      await pool.query(
        'DELETE FROM plaid_transactions WHERE transaction_id = $1 AND user_id = $2 AND is_confirmed = false',
        [removedTx.transaction_id, item.user_id]
      );
    }

    // Handle modified transactions — Plaid sends these when a pending transaction settles
    // without changing its transaction_id (common for some institutions). The record already
    // exists in plaid_transactions; we update is_pending and auto-confirm if now settled.
    for (const tx of modifiedTransactions) {
      if (tx.pending) continue; // still pending — no action needed
      if (tx.amount <= 0) continue; // credit/refund — skip
      try {
        await pool.query(
          'UPDATE plaid_transactions SET is_pending = false, updated_at = NOW() WHERE transaction_id = $1 AND user_id = $2',
          [tx.transaction_id, item.user_id]
        );
        const { rows: existingTx } = await pool.query(
          'SELECT * FROM plaid_transactions WHERE transaction_id = $1 AND user_id = $2 AND is_confirmed = false LIMIT 1',
          [tx.transaction_id, item.user_id]
        );
        if (!existingTx.length) continue;
        const ptx = existingTx[0];
        const expDate = String(tx.date).slice(0, 10);
        const { rows: dup } = await pool.query(
          'SELECT id FROM expenses WHERE plaid_transaction_id = $1 LIMIT 1',
          [tx.transaction_id]
        );
        let expenseId = dup[0]?.id || null;
        if (!expenseId) {
          const cols = ['user_id', 'amount', 'description', 'expense_date', 'source', 'plaid_transaction_id'];
          const vals = [item.user_id, parseFloat(tx.amount), tx.merchant_name || tx.name || 'Unknown', expDate, 'plaid', tx.transaction_id];
          if (ptx.category_id) { cols.push('category_id'); vals.push(ptx.category_id); }
          const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
          const { rows: expRows } = await pool.query(
            `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING id`, vals
          );
          expenseId = expRows[0]?.id || null;
        }
        if (expenseId) {
          await pool.query(
            'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
            [expenseId, ptx.id]
          );
          added++;
          console.log(`[Plaid] Modified tx settled and confirmed: ${tx.transaction_id} → expense ${expenseId}`);
        }
      } catch (e) {
        console.error('[Plaid] Error handling modified tx', tx.transaction_id, e.message);
      }
    }

    cursor = next_cursor;
    hasMore = has_more;
    if (!hasMore) break;
  }

  await updateItemCursor(pool, item.id, cursor);

  // Store account balances from last sync page so card can show them without a live Plaid call
  for (const acc of lastSyncAccounts) {
    if (acc.balances?.current != null || acc.balances?.available != null) {
      await pool.query(
        `UPDATE plaid_accounts
         SET current_balance = $1, available_balance = $2, balance_updated_at = NOW()
         WHERE account_id = $3 AND user_id = $4`,
        [acc.balances.current ?? null, acc.balances.available ?? null, acc.account_id, item.user_id]
      );
    }
  }

  console.log(`[Plaid] Synced item ${item.id} for user ${item.user_id}: plaid_returned=${totalFromPlaid}, inserted=${added}, skipped_credits=${skippedCredit}, skipped_no_acct=${skippedNoAcct}, insert_failed=${insertFailed}`);

  if (billCandidates.length > 0) {
    detectAndCreateBillTasks(pool, item.user_id, billCandidates).catch(e => console.error('[BillTasks] Error:', e.message));
  }
  return { added, plaidReturned: totalFromPlaid, skippedCredit, skippedNoAcct, insertFailed, accountMapSize: Object.keys(accountMap).length };
}

// ── Bill detection + auto-task creation ──────────────────────────────────────
async function detectAndCreateBillTasks(pool, userId, newTransactionData) {
  if (!newTransactionData || newTransactionData.length === 0) return;
  const disabledMerchants = await getDisabledMerchantKeys(pool, userId);
  const tasksCreated = [];

  for (const tx of newTransactionData) {
    const billInfo = detectBillType(tx);
    if (!billInfo) continue;
    const merchantName = tx.merchant_name || tx.name || tx.description || 'Unknown';
    const merchantKey = normalizeMerchantKey(merchantName);
    if (!merchantKey || disabledMerchants.has(merchantKey)) continue;
    const displayName = billInfo.label || merchantName;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 35);
    const { rows: existing } = await pool.query(
      `SELECT id FROM tasks WHERE user_id = $1 AND source = 'auto_bill' AND bill_merchant_key = $2
       AND is_completed = false AND created_at >= $3 LIMIT 1`,
      [userId, merchantKey, cutoff]
    );
    if (existing.length) continue;

    const txDate = tx.transaction_date ? new Date(tx.transaction_date) : new Date();
    const dueDate = new Date(txDate);
    dueDate.setDate(dueDate.getDate() + 3);

    await pool.query(
      `INSERT INTO tasks (user_id, title, description, priority, due_date, source, bill_merchant_key, bill_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        `Pay ${displayName}`,
        `Auto-detected from bank sync. ${getBillTypeLabel(billInfo.type)} payment.`,
        'high',
        dueDate,
        'auto_bill',
        merchantKey,
        billInfo.type,
      ]
    );
    tasksCreated.push({ merchantKey, displayName, type: billInfo.type });
    await trackBillMerchant(pool, userId, merchantKey, displayName, billInfo.type);
  }

  if (tasksCreated.length > 0) {
    console.log(`[BillTasks] Created ${tasksCreated.length} bill task(s) for user ${userId}:`, tasksCreated.map(t => t.displayName).join(', '));
  }
}

// ── Express Router ────────────────────────────────────────────────────────────
module.exports = function(pool) {
  const router = express.Router();

  // GET /api/plaid/diagnostic — test Plaid API keys directly, no auth required
  router.get('/diagnostic', async (req, res) => {
    const clientId = (process.env.PLAID_CLIENT_ID || '').trim();
    const secret   = (process.env.PLAID_SECRET || '').trim();
    const plaidEnv = (process.env.PLAID_ENV || 'sandbox').trim();
    const plaid = getPlaidClient();
    // WHY expose lengths/prefixes: helps identify truncated or swapped credentials
    // without leaking the full secret
    const diagInfo = {
      env: plaidEnv,
      has_client_id: !!clientId,
      has_secret: !!secret,
      client_id_length: clientId.length,
      secret_length: secret.length,
      client_id_prefix: clientId.substring(0, 6) + '...',
      secret_prefix: secret.substring(0, 4) + '...',
    };
    if (!plaid) {
      return res.json({
        success: false, configured: false, ...diagInfo,
        message: 'PLAID_CLIENT_ID or PLAID_SECRET not set in environment',
      });
    }
    try {
      await plaid.linkTokenCreate({
        user: { client_user_id: 'diagnostic-test' },
        client_name: 'FocusLedger Diagnostic',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      });
      res.json({ success: true, configured: true, ...diagInfo, message: 'Plaid API keys are working. Environment: ' + plaidEnv });
    } catch (err) {
      const plaidErr = err.response?.data || err.message;
      const errorCode = plaidErr?.error_code || 'unknown';
      const errorMsg  = plaidErr?.error_message || plaidErr?.display_message || err.message;
      const errorType = plaidErr?.error_type || 'api_error';
      console.error('[Plaid] Diagnostic failed: code=' + errorCode + ' type=' + errorType + ' msg=' + errorMsg);
      const hint = errorCode === 'INVALID_API_KEYS'
        ? `Credentials rejected by Plaid (env=${plaidEnv}). Verify: (1) the secret matches what's in Plaid Dashboard > Keys for the "${plaidEnv}" environment, (2) the secret wasn't truncated during copy-paste, (3) you're not mixing sandbox and production keys.`
        : null;
      res.json({
        success: false, configured: true, ...diagInfo,
        error_code: errorCode, error_type: errorType, error_message: errorMsg,
        hint,
        message: 'Plaid API error: ' + errorMsg + ' (' + errorCode + ')',
      });
    }
  });

  router.use(requireAuth);

  // GET /api/plaid/db-status — authenticated DB-state diagnostic; shows exactly what's stored
  // for this user's Plaid setup so we can pinpoint sync failures without reading Render logs.
  router.get('/db-status', async (req, res) => {
    try {
      const userId = req.user.id;
      const { rows: items } = await pool.query(
        `SELECT id, item_id, institution_name, cursor IS NOT NULL AS has_cursor,
                last_synced_at, created_at
         FROM plaid_items WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      const itemIds = items.map(i => i.id);
      const { rows: accounts } = itemIds.length
        ? await pool.query(
            `SELECT id, plaid_item_id, account_id, name, type, subtype
             FROM plaid_accounts WHERE plaid_item_id = ANY($1) ORDER BY plaid_item_id, id`,
            [itemIds]
          )
        : { rows: [] };
      const { rows: txStats } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_confirmed = true)::int  AS confirmed,
                COUNT(*) FILTER (WHERE is_pending   = true)::int  AS pending,
                MIN(transaction_date) AS earliest, MAX(transaction_date) AS latest
         FROM plaid_transactions WHERE user_id = $1`,
        [userId]
      );
      const { rows: expStats } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_impulse IS NULL)::int AS untriaged,
                MIN(expense_date) AS earliest, MAX(expense_date) AS latest
         FROM expenses WHERE user_id = $1 AND source = 'plaid'`,
        [userId]
      );
      const { rows: constraintCheck } = await pool.query(
        `SELECT COUNT(*)::int AS unique_indexes
         FROM pg_indexes
         WHERE tablename = 'plaid_transactions'
           AND indexdef ILIKE '%transaction_id%'
           AND indexdef ILIKE '%unique%'`
      );
      res.json({
        success: true,
        plaid_env: (process.env.PLAID_ENV || 'sandbox').trim(),
        items: items.map(item => ({
          ...item,
          accounts: accounts.filter(a => a.plaid_item_id === item.id),
        })),
        plaid_transactions: txStats[0] || {},
        plaid_expenses: expStats[0] || {},
        schema: {
          plaid_transactions_has_unique_on_transaction_id: constraintCheck[0]?.unique_indexes > 0,
        },
      });
    } catch (err) {
      console.error('[Plaid] db-status error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // GET /api/plaid/sync-diagnostic — calls Plaid transactionsSync directly and returns raw result.
  // Use this when the money tab shows 0 transactions and you can't read Render logs.
  router.get('/sync-diagnostic', async (req, res) => {
    try {
      const userId = req.user.id;
      const { rows: items } = await pool.query(
        'SELECT * FROM plaid_items WHERE user_id = $1 ORDER BY id DESC LIMIT 5',
        [userId]
      );
      if (!items.length) return res.json({ success: false, message: 'No plaid_items for this user.' });

      const plaid = getPlaidClient();
      if (!plaid) return res.json({ success: false, message: 'Plaid client not initialized — check PLAID_CLIENT_ID / PLAID_SECRET env vars.', plaid_env: process.env.PLAID_ENV || 'sandbox' });

      const results = [];
      for (const item of items) {
        const accessToken = decryptPlaidToken(item.access_token);
        const itemResult = {
          item_db_id: item.id,
          institution_name: item.institution_name,
          plaid_item_id: item.item_id,
          cursor_set: !!item.cursor,
          last_synced_at: item.last_synced_at,
        };
        try {
          // Page through ALL available transactions to get a true total count.
          let diagCursor;
          let diagHasMore = true;
          let totalAdded = 0, totalPending = 0, totalSettled = 0, totalCredits = 0;
          let sampleTxs = [];
          let allAccountIds = new Set();
          let firstPage = true;
          while (diagHasMore) {
            const resp = await plaid.transactionsSync({
              access_token: accessToken,
              cursor: diagCursor,
              count: 100,
            });
            const { added, next_cursor, has_more, accounts } = resp.data;
            if (firstPage) {
              itemResult.account_ids_in_response = accounts.map(a => a.account_id);
              firstPage = false;
            }
            for (const tx of added) {
              allAccountIds.add(tx.account_id);
              totalAdded++;
              if (tx.pending) totalPending++;
              else totalSettled++;
              if (tx.amount <= 0) totalCredits++;
              if (sampleTxs.length < 5) sampleTxs.push({ id: tx.transaction_id, account_id: tx.account_id, date: tx.date, amount: tx.amount, name: tx.merchant_name || tx.name, pending: tx.pending });
            }
            diagCursor = next_cursor;
            diagHasMore = has_more;
          }
          itemResult.success = true;
          itemResult.total_available_from_plaid = totalAdded;
          itemResult.settled = totalSettled;
          itemResult.pending = totalPending;
          itemResult.credits_refunds = totalCredits;
          itemResult.sample_transactions = sampleTxs;
          const { rows: accts } = await pool.query(
            'SELECT account_id FROM plaid_accounts WHERE plaid_item_id = $1', [item.id]
          );
          const storedIds = accts.map(a => a.account_id);
          const unmapped = [...allAccountIds].filter(id => !storedIds.includes(id));
          itemResult.stored_account_ids = storedIds;
          itemResult.unmapped_account_ids_in_response = unmapped;
          if (unmapped.length) itemResult.warning = 'Plaid returned transactions for account_ids not in plaid_accounts — these will be skipped by syncTransactions.';
          // Also show what's in DB for comparison
          const { rows: dbStats } = await pool.query(
            `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_pending)::int pending, COUNT(*) FILTER (WHERE is_confirmed)::int confirmed FROM plaid_transactions WHERE user_id = $1`,
            [userId]
          );
          itemResult.in_db = dbStats[0];
        } catch (e) {
          itemResult.success = false;
          itemResult.plaid_error_code = e.response?.data?.error_code || null;
          itemResult.plaid_error_type = e.response?.data?.error_type || null;
          itemResult.plaid_error_message = e.response?.data?.error_message || e.message;
          itemResult.http_status = e.response?.status || null;
        }
        results.push(itemResult);
      }

      res.json({
        success: true,
        plaid_env: (process.env.PLAID_ENV || 'sandbox').trim(),
        items: results,
      });
    } catch (err) {
      console.error('[Plaid] sync-diagnostic error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // GET /api/plaid/balances — live balances; falls back to DB cache if Plaid call fails
  router.get('/balances', async (req, res) => {
    try {
      const userId = req.user.id;
      const plaid = getPlaidClient();

      // Always load DB accounts (needed for fallback and account_id → name mapping)
      const { rows: dbAccounts } = await pool.query(
        `SELECT pa.account_id, pa.name, pa.official_name, pa.type, pa.subtype, pa.mask,
                pa.current_balance, pa.available_balance, pa.balance_updated_at,
                pi.id AS item_id, pi.institution_name
         FROM plaid_accounts pa
         JOIN plaid_items pi ON pa.plaid_item_id = pi.id
         WHERE pa.user_id = $1
         ORDER BY pi.created_at DESC`,
        [userId]
      );

      if (!dbAccounts.length) return res.json({ success: true, items: [] });

      // Group by item for the response shape the frontend expects
      const byItem = {};
      for (const a of dbAccounts) {
        if (!byItem[a.item_id]) byItem[a.item_id] = { item_id: a.item_id, institution: a.institution_name, accounts: [] };
        byItem[a.item_id].accounts.push({
          account_id: a.account_id, name: a.name, official_name: a.official_name,
          type: a.type, subtype: a.subtype, mask: a.mask,
          balances: {
            current: a.current_balance != null ? parseFloat(a.current_balance) : null,
            available: a.available_balance != null ? parseFloat(a.available_balance) : null,
          },
          _from_cache: true,
        });
      }

      // Try live Plaid call and overwrite cache entries that succeed
      if (plaid) {
        const { rows: items } = await pool.query(
          'SELECT * FROM plaid_items WHERE user_id = $1 ORDER BY created_at DESC', [userId]
        );
        for (const item of items) {
          const accessToken = decryptPlaidToken(item.access_token);
          if (!accessToken) continue;
          try {
            const resp = await plaid.accountsBalanceGet({ access_token: accessToken });
            const liveAccounts = resp.data.accounts.map(a => ({
              account_id: a.account_id, name: a.name, official_name: a.official_name,
              type: a.type, subtype: a.subtype, mask: a.mask,
              balances: { available: a.balances.available, current: a.balances.current,
                          iso_currency_code: a.balances.iso_currency_code },
            }));
            byItem[item.id] = { item_id: item.id, institution: item.institution_name, accounts: liveAccounts };
            // Persist fresh balances to DB
            for (const a of resp.data.accounts) {
              if (a.balances.current != null || a.balances.available != null) {
                pool.query(
                  `UPDATE plaid_accounts SET current_balance=$1, available_balance=$2, balance_updated_at=NOW()
                   WHERE account_id=$3 AND user_id=$4`,
                  [a.balances.current ?? null, a.balances.available ?? null, a.account_id, userId]
                ).catch(e => console.warn('[plaid] balance cache update failed:', e.message));
              }
            }
          } catch (e) {
            console.warn('[Plaid] Live balance fetch failed for item', item.id, '(using cached):', e.message);
          }
        }
      }

      res.json({ success: true, items: Object.values(byItem) });
    } catch (err) {
      console.error('[Plaid] Balances error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch balances' });
    }
  });

  router.get('/status', async (req, res) => {
    try {
      const userId = req.user.id;
      const isConfigured = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
      const plaidEnv = process.env.PLAID_ENV || 'sandbox';
      const isPro = await checkProStatus(pool, userId);
      const { rows: items } = await pool.query(
        `SELECT pi.*, json_agg(json_build_object(
           'id', pa.id, 'name', pa.name, 'type', pa.type, 'subtype', pa.subtype, 'mask', pa.mask
         )) FILTER (WHERE pa.id IS NOT NULL) AS plaid_accounts
         FROM plaid_items pi
         LEFT JOIN plaid_accounts pa ON pa.plaid_item_id = pi.id
         WHERE pi.user_id = $1
         GROUP BY pi.id
         ORDER BY pi.created_at DESC`,
        [userId]
      );
      const { rows: pendingRows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM plaid_transactions WHERE user_id = $1 AND is_confirmed = false AND is_pending = false',
        [userId]
      );
      res.json({
        success: true, is_configured: isConfigured, plaid_env: plaidEnv, is_pro: isPro,
        items: items.map(i => ({ ...i, plaid_accounts: i.plaid_accounts || [] })),
        pending_review_count: pendingRows[0].c,
      });
    } catch (err) {
      console.error('[Plaid] Error getting status:', err);
      res.status(500).json({ success: false, message: 'Failed to get Plaid status' });
    }
  });

  router.post('/create-link-token', async (req, res) => {
    try {
      const userId = req.user.id;
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      if (!isPro) return res.status(403).json({ success: false, message: 'Bank sync is an Autopilot feature.' });
      const plaid = getPlaidClient();
      if (!plaid) {
        console.error('[Plaid] create-link-token: Plaid client not initialized — PLAID_CLIENT_ID or PLAID_SECRET missing');
        return res.status(503).json({ success: false, message: 'Bank sync is being set up.' });
      }
      const linkTokenParams = {
        user: { client_user_id: String(userId) },
        client_name: 'FocusLedger',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      };
      if (process.env.PLAID_WEBHOOK_URL) {
        linkTokenParams.webhook = process.env.PLAID_WEBHOOK_URL;
      }
      const response = await plaid.linkTokenCreate(linkTokenParams);
      res.json({ success: true, link_token: response.data.link_token });
    } catch (err) {
      const plaidErr = err.response?.data || err.message;
      const errorCode = plaidErr?.error_code || 'unknown';
      const errorMsg  = plaidErr?.error_message || plaidErr?.display_message || err.message;
      const errorType = plaidErr?.error_type || 'api_error';
      console.error(`[Plaid] Error creating link token: userId=${req.user?.id} code=${errorCode} type=${errorType} msg=${errorMsg}`);
      const userMsg = errorCode === 'INVALID_PRODUCT'   ? 'Bank sync is not available for this account type.'
                 : errorCode === 'INVALID_API_KEYS'     ? 'Bank connection credentials need to be updated. We\'re on it — check back soon.'
                 : errorCode === 'PRODUCT_NOT_READY'    ? 'Bank sync is still initializing. Try again in a moment.'
                 :                                       'Connection did not start. Give it another try?';
      res.status(500).json({ success: false, message: userMsg, error_code: errorCode });
    }
  });

  router.post('/create-update-token', async (req, res) => {
    try {
      const userId = req.user.id;
      const { item_id } = req.body;
      if (!item_id) return res.status(400).json({ success: false, message: 'item_id required' });
      const plaid = getPlaidClient();
      if (!plaid) return res.status(503).json({ success: false, message: 'Bank sync is being set up.' });
      const { rows } = await pool.query('SELECT * FROM plaid_items WHERE id = $1 AND user_id = $2', [parseInt(item_id), userId]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Item not found' });
      const accessToken = decryptPlaidToken(rows[0].access_token);
      const linkTokenParams = {
        user: { client_user_id: String(userId) },
        client_name: 'FocusLedger',
        country_codes: ['US'],
        language: 'en',
        access_token: accessToken,
      };
      if (process.env.PLAID_WEBHOOK_URL) linkTokenParams.webhook = process.env.PLAID_WEBHOOK_URL;
      const response = await plaid.linkTokenCreate(linkTokenParams);
      res.json({ success: true, link_token: response.data.link_token });
    } catch (err) {
      const plaidErr = err.response?.data || err.message;
      console.error('[Plaid] Error creating update token:', plaidErr);
      res.status(500).json({ success: false, message: 'Could not start reconnect. Try again?' });
    }
  });

  router.post('/exchange-token', async (req, res) => {
    try {
      const userId = req.user.id;
      const { public_token, institution_name, institution_id } = req.body;
      if (!public_token) return res.status(400).json({ success: false, message: 'public_token required' });
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      if (!isPro) return res.status(403).json({ success: false, message: 'Bank sync is an Autopilot feature.' });
      const plaid = getPlaidClient();
      if (!plaid) return res.status(503).json({ success: false, message: 'Bank sync is being set up.' });
      const exchangeResponse = await plaid.itemPublicTokenExchange({ public_token });
      const { access_token, item_id } = exchangeResponse.data;
      const plaidItem = await upsertPlaidItem(pool, userId, encryptPlaidToken(access_token), item_id, institution_name || 'Unknown Bank', institution_id || null);
      console.log(`[Plaid] exchange-token: upserted item id=${plaidItem.id} item_id=${item_id} user=${userId}`);
      const accountsResponse = await plaid.accountsGet({ access_token });
      console.log(`[Plaid] exchange-token: Plaid returned ${accountsResponse.data.accounts.length} account(s)`);
      for (const acc of accountsResponse.data.accounts) {
        const saved = await upsertPlaidAccount(pool, plaidItem.id, userId, acc.account_id, acc.name, acc.official_name || null, acc.type, acc.subtype || null, acc.mask || null,
          acc.balances?.current ?? null, acc.balances?.available ?? null);
        console.log(`[Plaid] exchange-token: upserted account db_id=${saved?.id} plaid_item_id=${saved?.plaid_item_id} account_id=${acc.account_id} name="${acc.name}"`);
      }
      if (process.env.PLAID_WEBHOOK_URL) {
        plaid.itemWebhookUpdate({ access_token, webhook: process.env.PLAID_WEBHOOK_URL })
          .then(() => {
            _webhookRegistered.add(plaidItem.id);
            console.log(`[Plaid] Registered webhook for item ${plaidItem.id}`);
          })
          .catch(e => console.warn('[Plaid] itemWebhookUpdate error:', e.message));
      }
      syncTransactions(pool, plaidItem).catch(e => console.error('[Plaid] Initial sync error:', e.message));
      res.json({ success: true, message: 'Connected. Bringing in your transactions.', item_id: plaidItem.id, institution_name: plaidItem.institution_name });
    } catch (err) {
      const plaidData = err.response?.data;
      console.error('[Plaid] Error exchanging token:', plaidData || err.message);
      const plaidCode = plaidData?.error_code;
      const plaidMsg = plaidData?.error_message || plaidData?.display_message;
      const dbError = !plaidData && err.message;
      res.status(500).json({
        success: false,
        message: 'That connection did not go through. Try again?',
        plaid_error_code: plaidCode || null,
        plaid_error_message: plaidMsg || null,
        internal_error: dbError || null,
      });
    }
  });

  router.post('/sync', async (req, res) => {
    try {
      const userId = req.user.id;
      const { item_id, force_full } = req.body;
      const where = item_id
        ? 'WHERE id = $1 AND user_id = $2'
        : 'WHERE user_id = $1';
      const vals = item_id ? [parseInt(item_id), userId] : [userId];
      const { rows: items } = await pool.query(`SELECT * FROM plaid_items ${where}`, vals);
      let totalAdded = 0, totalPlaidReturned = 0, totalSkippedCredit = 0, totalSkippedNoAcct = 0, totalInsertFailed = 0, totalAccountMapSize = 0;
      const syncPlaid = getPlaidClient();
      for (const item of items) {
        if (force_full) {
          // Reset cursor so Plaid re-delivers full transaction history from the start.
          // Safe to re-run: expenses dedup by plaid_transaction_id, plaid_transactions dedup by UNIQUE index.
          await updateItemCursor(pool, item.id, null);
          item.cursor = null;
          console.log('[Plaid] Full resync requested for item', item.id, 'user', userId, '— cursor reset');

          // Re-fetch accounts from Plaid so the accountMap is always current.
          // This fixes the case where plaid_accounts has stale / missing rows,
          // which would cause every transaction to be skipped (skipped_no_account++).
          if (syncPlaid) {
            try {
              const accessToken = decryptPlaidToken(item.access_token);
              const acctResp = await syncPlaid.accountsGet({ access_token: accessToken });
              for (const acc of acctResp.data.accounts) {
                await upsertPlaidAccount(pool, item.id, userId, acc.account_id, acc.name,
                  acc.official_name || null, acc.type, acc.subtype || null, acc.mask || null,
                  acc.balances?.current ?? null, acc.balances?.available ?? null);
              }
              console.log(`[Plaid] Full resync: refreshed ${acctResp.data.accounts.length} account(s) for item ${item.id}`);
            } catch (e) {
              console.warn('[Plaid] Full resync: account refresh failed for item', item.id, ':', e.message);
            }
          }
        }
        // Register webhook URL for existing items that were connected before PLAID_WEBHOOK_URL was set.
        if (syncPlaid && process.env.PLAID_WEBHOOK_URL && !_webhookRegistered.has(item.id)) {
          _webhookRegistered.add(item.id);
          syncPlaid.itemWebhookUpdate({ access_token: decryptPlaidToken(item.access_token), webhook: process.env.PLAID_WEBHOOK_URL })
            .then(() => console.log(`[Plaid] Registered webhook for existing item ${item.id}`))
            .catch(e => console.warn('[Plaid] itemWebhookUpdate error for item', item.id, ':', e.message));
        }
        const result = await syncTransactions(pool, item);
        totalAdded += result.added;
        totalPlaidReturned += result.plaidReturned;
        totalSkippedCredit += result.skippedCredit;
        totalSkippedNoAcct += result.skippedNoAcct;
        totalInsertFailed += result.insertFailed;
        totalAccountMapSize += result.accountMapSize || 0;
      }
      const diagMsg = totalInsertFailed > 0
        ? `${totalAdded} inserted, ${totalInsertFailed} failed — check server logs`
        : `${totalAdded} new transactions ready to review`;
      res.json({
        success: true,
        transactions_added: totalAdded,
        plaid_returned: totalPlaidReturned,
        skipped_credits: totalSkippedCredit,
        skipped_no_account: totalSkippedNoAcct,
        insert_failed: totalInsertFailed,
        account_map_size: totalAccountMapSize,
        message: diagMsg,
      });
    } catch (err) {
      const plaidCode = err.response?.data?.error_code;
      console.error('[Plaid] Error syncing:', err.response?.data || err.message);
      if (plaidCode === 'ITEM_LOGIN_REQUIRED') {
        return res.json({ success: false, needs_reconnect: true, message: 'Bank connection expired — click Reconnect to re-authenticate.' });
      }
      res.status(500).json({ success: false, message: 'Sync did not complete. Try again in a moment.' });
    }
  });

  router.get('/transactions/pending', async (req, res) => {
    try {
      const userId = req.user.id;
      const { rows: txs } = await pool.query(
        `SELECT pt.*, c.name as category_name, c.color as category_color, c.icon as category_icon,
                pa.name as account_name, pa.mask
         FROM plaid_transactions pt
         LEFT JOIN categories c ON pt.category_id = c.id
         LEFT JOIN plaid_accounts pa ON pt.plaid_account_id = pa.id
         WHERE pt.user_id = $1 AND pt.is_confirmed = false AND pt.is_pending = false
         ORDER BY pt.transaction_date DESC, pt.created_at DESC
         LIMIT 50`,
        [userId]
      );
      res.json({ success: true, transactions: txs });
    } catch (err) { console.error('[Plaid] Error fetching pending:', err); res.status(500).json({ success: false, message: 'Failed to fetch pending transactions' }); }
  });

  router.patch('/transactions/:id/category', async (req, res) => {
    try {
      const userId = req.user.id; const { id } = req.params; const { category_name } = req.body;
      if (!category_name) return res.status(400).json({ success: false, message: 'category_name required' });
      const { rows: catRows } = await pool.query(
        'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
        [category_name]
      );
      if (!catRows.length) return res.status(404).json({ success: false, message: 'Category not found' });
      const { rows: txRows } = await pool.query(
        'SELECT id FROM plaid_transactions WHERE id = $1 AND user_id = $2',
        [parseInt(id), userId]
      );
      if (!txRows.length) return res.status(404).json({ success: false, message: 'Transaction not found' });
      await pool.query(
        'UPDATE plaid_transactions SET category_id = $1, updated_at = NOW() WHERE id = $2',
        [catRows[0].id, parseInt(id)]
      );
      res.json({ success: true, category_id: catRows[0].id });
    } catch (err) { console.error('[Plaid] Error updating category:', err); res.status(500).json({ success: false, message: 'Category did not save. Worth retrying.' }); }
  });

  router.post('/transactions/:id/confirm', async (req, res) => {
    try {
      const userId = req.user.id; const { id } = req.params;
      const { rows: txRows } = await pool.query(
        'SELECT * FROM plaid_transactions WHERE id = $1 AND user_id = $2 AND is_confirmed = false',
        [parseInt(id), userId]
      );
      if (!txRows.length) return res.status(404).json({ success: false, message: 'Transaction not found' });
      const tx = txRows[0];
      const expDate = tx.transaction_date ? String(tx.transaction_date).slice(0, 10) : new Date().toISOString().split('T')[0];

      const cols = ['user_id', 'amount', 'description', 'expense_date', 'source'];
      const vals = [userId, parseFloat(tx.amount), tx.description || tx.merchant_name || 'Unknown', expDate, 'plaid'];
      if (tx.category_id != null) { cols.push('category_id'); vals.push(tx.category_id); }
      if (tx.transaction_id) { cols.push('plaid_transaction_id'); vals.push(tx.transaction_id); }

      const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
      const { rows: expRows } = await pool.query(
        `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
        vals
      );
      await pool.query(
        'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
        [expRows[0].id, parseInt(id)]
      );
      res.json({ success: true, expense_id: expRows[0].id });
    } catch (err) { console.error('[Plaid] Error confirming:', err); res.status(500).json({ success: false, message: 'Could not confirm that one. Try again?' }); }
  });

  router.post('/task-suggestions/:taskId/accept', async (req, res) => {
    try {
      const userId = req.user.id; const { taskId } = req.params; const { transaction_id, amount, merchant, date } = req.body;
      const { rows: taskRows } = await pool.query(
        'SELECT id, title FROM tasks WHERE id = $1 AND user_id = $2 AND is_completed = false',
        [parseInt(taskId), userId]
      );
      if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found or already completed' });
      const task = taskRows[0];
      const note = `Auto-completed — $${parseFloat(amount || 0).toFixed(2)} from ${merchant || 'bank'} on ${date || 'unknown date'}`;
      await pool.query(
        'UPDATE tasks SET is_completed = true, completed_at = NOW(), updated_at = NOW(), auto_complete_note = $1, auto_complete_transaction_id = $2 WHERE id = $3',
        [note, transaction_id || null, parseInt(taskId)]
      );
      res.json({ success: true, task: { id: task.id, title: task.title, auto_complete_note: note } });
    } catch (err) { console.error('[Plaid] Error accepting task suggestion:', err); res.status(500).json({ success: false, message: 'Failed to complete task' }); }
  });

  router.post('/transactions/confirm-all', async (req, res) => {
    try {
      const userId = req.user.id;
      const { rows: pending } = await pool.query(
        'SELECT id FROM plaid_transactions WHERE user_id = $1 AND is_confirmed = false AND is_pending = false',
        [userId]
      );
      let confirmed = 0;
      for (const row of pending) {
        try {
          const { rows: txRows } = await pool.query(
            'SELECT * FROM plaid_transactions WHERE id = $1 AND is_confirmed = false',
            [row.id]
          );
          if (!txRows.length) continue;
          const tx = txRows[0];
          const expDate = tx.transaction_date ? String(tx.transaction_date).slice(0, 10) : new Date().toISOString().split('T')[0];

          // Check for an existing expense first to avoid relying on ON CONFLICT
          let expenseId = null;
          if (tx.transaction_id) {
            const { rows: dup } = await pool.query(
              'SELECT id FROM expenses WHERE plaid_transaction_id = $1 LIMIT 1',
              [tx.transaction_id]
            );
            expenseId = dup[0]?.id || null;
          }

          if (!expenseId) {
            const cols = ['user_id', 'amount', 'description', 'expense_date', 'source'];
            const vals = [userId, parseFloat(tx.amount), tx.description || tx.merchant_name || 'Unknown', expDate, 'plaid'];
            if (tx.category_id != null) { cols.push('category_id'); vals.push(tx.category_id); }
            if (tx.transaction_id) { cols.push('plaid_transaction_id'); vals.push(tx.transaction_id); }
            const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
            const { rows: expRows } = await pool.query(
              `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
              vals
            );
            expenseId = expRows[0]?.id || null;
          }

          if (expenseId) {
            await pool.query(
              'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
              [expenseId, row.id]
            );
            confirmed++;
          }
        } catch (e) { console.error('[Plaid] Error confirming tx:', row.id, e.message); }
      }
      res.json({ success: true, confirmed_count: confirmed });
    } catch (err) { console.error('[Plaid] Error bulk confirming:', err); res.status(500).json({ success: false, message: 'Failed to confirm transactions' }); }
  });

  router.post('/transactions/:id/dismiss', async (req, res) => {
    try {
      const userId = req.user.id; const { id } = req.params;
      const { rows } = await pool.query(
        'SELECT id FROM plaid_transactions WHERE id = $1 AND user_id = $2',
        [parseInt(id), userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Transaction not found' });
      await pool.query(
        'UPDATE plaid_transactions SET is_confirmed = true, updated_at = NOW() WHERE id = $1',
        [parseInt(id)]
      );
      res.json({ success: true });
    } catch (err) { console.error('[Plaid] Error dismissing:', err); res.status(500).json({ success: false, message: 'Failed to dismiss transaction' }); }
  });

  router.get('/bills', async (req, res) => {
    try {
      const userId = req.user.id;
      const { rows } = await pool.query(
        `SELECT bp.merchant_key, bp.merchant_display_name, bp.bill_type, bp.is_disabled,
                COUNT(t.id) FILTER (WHERE t.is_completed = false)::int AS active_tasks,
                MAX(t.created_at) AS last_task_created_at
         FROM bill_preferences bp
         LEFT JOIN tasks t ON t.bill_merchant_key = bp.merchant_key AND t.user_id = bp.user_id
         WHERE bp.user_id = $1
         GROUP BY bp.merchant_key, bp.merchant_display_name, bp.bill_type, bp.is_disabled
         ORDER BY bp.merchant_display_name`,
        [userId]
      );
      res.json({ success: true, bills: rows });
    } catch (err) { console.error('[BillTasks] Error fetching bills:', err); res.status(500).json({ success: false, message: 'Failed to fetch bill preferences' }); }
  });

  router.post('/bills/:key/disable', async (req, res) => {
    try {
      const userId = req.user.id; const { key } = req.params;
      await pool.query(
        `INSERT INTO bill_preferences (user_id, merchant_key, is_disabled)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, merchant_key) DO UPDATE SET is_disabled = true, updated_at = NOW()`,
        [userId, key]
      );
      res.json({ success: true, message: 'Auto-tasks disabled for this bill' });
    } catch (err) { console.error('[BillTasks] Error disabling bill:', err); res.status(500).json({ success: false, message: 'Could not update that bill. Try again?' }); }
  });

  router.post('/bills/:key/enable', async (req, res) => {
    try {
      const userId = req.user.id; const { key } = req.params;
      await pool.query(
        `INSERT INTO bill_preferences (user_id, merchant_key, is_disabled)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id, merchant_key) DO UPDATE SET is_disabled = false, updated_at = NOW()`,
        [userId, key]
      );
      res.json({ success: true, message: 'Auto-tasks re-enabled for this bill' });
    } catch (err) { console.error('[BillTasks] Error enabling bill:', err); res.status(500).json({ success: false, message: 'Could not update that bill. Try again?' }); }
  });

  router.delete('/items/:id', async (req, res) => {
    try {
      const userId = req.user.id; const { id } = req.params;
      const { rows } = await pool.query(
        'SELECT * FROM plaid_items WHERE id = $1 AND user_id = $2',
        [parseInt(id), userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Item not found' });
      const item = rows[0];
      const plaid = getPlaidClient();
      if (plaid) { try { await plaid.itemRemove({ access_token: decryptPlaidToken(item.access_token) }); } catch (e) { console.warn('[Plaid] Could not remove item from Plaid:', e.message); } }
      await deletePlaidItem(pool, parseInt(id), userId);
      res.json({ success: true, message: 'Account disconnected.' });
    } catch (err) { console.error('[Plaid] Error removing item:', err); res.status(500).json({ success: false, message: 'Could not disconnect. Try again?' }); }
  });

  return router;
};
