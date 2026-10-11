'use strict';
/**
 * Bill guardian: find recurring charges in a user's bank history, predict the
 * next one, and sort each into a bucket that decides what the agent does.
 *
 *   obligation   rent, utilities, loans, insurance, card payments: missing one
 *                costs money, so remind BEFORE it's due (and warn on balance)
 *   subscription auto-charged and cancellable: no reminders; a "still using?"
 *                review is the useful nudge (forgotten subs = ADHD tax)
 *   habit        nails, haircuts, coffee: recurring but discretionary; never
 *                reminded
 *   unsure       looks bill-like but the signals disagree: ask the user once,
 *                remember the answer (bill_preferences.bucket)
 *
 * Works from the transactions FocusLedger already stores, so it needs no Plaid
 * add-on and has history from day one (Plaid backfills on connect).
 * Pure functions here; queries live in db/bills.js, orchestration in
 * runBillGuardian (bottom).
 */
const { BILL_MERCHANT_PATTERNS, normalizeMerchantKey } = require('./bill-patterns');

const DAY = 86400000;
const REMIND_LEAD_DAYS = 3;

// Cadences, tolerance in days around the typical gap, and how many charges it
// takes before we trust the pattern.
const FREQUENCIES = [
  { key: 'weekly',    days: 7,     tol: 2,  minCount: 4 },
  { key: 'biweekly',  days: 14,    tol: 3,  minCount: 3 },
  { key: 'monthly',   days: 30.44, tol: 4,  minCount: 2 },
  { key: 'quarterly', days: 91.3,  tol: 10, minCount: 2 },
  { key: 'annual',    days: 365.2, tol: 15, minCount: 2 },
];

const OBLIGATION_PRIMARY = new Set(['RENT_AND_UTILITIES', 'LOAN_PAYMENTS']);
const OBLIGATION_DETAILED = /INSURANCE|CREDIT_CARD_PAYMENT|MORTGAGE|CAR_PAYMENT|STUDENT_LOAN|RENT|UTILIT|INTERNET|TELEPHONE|WATER|GAS_AND_ELECTRICITY|CHILDCARE/;
const SUBSCRIPTION_DETAILED = /TV_AND_MOVIES|MUSIC_AND_AUDIO|SUBSCRIPTION|DIGITAL|STREAMING/;
const HABIT_PRIMARY = new Set([
  'PERSONAL_CARE', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'TRANSPORTATION',
  'TRAVEL', 'ENTERTAINMENT', 'HOME_IMPROVEMENT', 'MEDICAL',
]);

const toDay = (d) => {
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  return Date.parse(s + 'T12:00:00Z');
};
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// History windows: getRecentOutflows reads ~2 years so annual bills show two
// charges; shorter cadences keep using the last ~13 months.
const SHORT_CADENCE_WINDOW_DAYS = 400;
const LONG_CADENCES = new Set(['quarterly', 'annual']);
/** The cadence whose typical gap matches these charge days, or null. */
function cadenceOf(days) {
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, i) => (d - days[i]) / DAY);
  const typicalGap = median(gaps);
  return FREQUENCIES.find(f => Math.abs(typicalGap - f.days) <= f.tol) || null;
}

/** Same day-of-month as `dom` in the month after `fromMs`, clamped to month length. */
function nextMonthly(fromMs, dom) {
  const d = new Date(fromMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(dom, last), 12);
}

/**
 * Group outflows into recurring streams.
 * @param {Array<{merchant_name?, description?, amount, transaction_date, plaid_category?}>} txs
 *   Plaid convention: amount > 0 is money out. Pending rows should be excluded by the caller.
 * @param {number} todayMs
 */
function detectStreams(txs, todayMs) {
  const groups = new Map();
  for (const t of txs) {
    const amount = Number(t.amount);
    if (!(amount > 0) || !t.transaction_date) continue;
    const name = (t.merchant_name || t.description || '').trim();
    const key = normalizeMerchantKey(name);
    if (!key) continue;
    const g = groups.get(key) || { key, name, category: null, charges: [] };
    g.charges.push({ day: toDay(t.transaction_date), amount });
    if (t.plaid_category && !g.category) g.category = String(t.plaid_category);
    groups.set(key, g);
  }

  const streams = [];
  for (const g of groups.values()) {
    // One charge per day per merchant (split/duplicate postings).
    const byDay = new Map();
    for (const c of g.charges) byDay.set(c.day, (byDay.get(c.day) || 0) + c.amount);
    const allDays = [...byDay.keys()].sort((a, b) => a - b);
    // Weekly/biweekly/monthly are judged on the last ~13 months only (as
    // before); quarterly/annual need the longer history to see two charges.
    let days = allDays.filter(d => todayMs - d <= SHORT_CADENCE_WINDOW_DAYS * DAY);
    let freq = cadenceOf(days);
    if (!freq || LONG_CADENCES.has(freq.key)) {
      const long = cadenceOf(allDays);
      if (long && LONG_CADENCES.has(long.key)) { days = allDays; freq = long; }
    }
    if (!freq || days.length < freq.minCount) continue;
    const gaps = days.slice(1).map((d, i) => (d - days[i]) / DAY);
    // Regular: allow at most one off-pattern gap (a skipped or late month).
    const offPattern = gaps.filter(gp => Math.abs(gp - freq.days) > freq.tol * 1.5).length;
    if (offPattern > (gaps.length >= 4 ? 1 : 0)) continue;

    const last = days[days.length - 1];
    // Stopped? (more than two cycles since the last charge)
    if ((todayMs - last) / DAY > freq.days * 2 + freq.tol) continue;

    const amounts = days.map(d => byDay.get(d));
    const typicalAmount = median(amounts);
    const doms = days.map(d => new Date(d).getUTCDate());
    const dom = Math.round(median(doms));
    let next = freq.key === 'monthly' ? nextMonthly(last, dom) : last + Math.round(freq.days) * DAY;
    // If we already passed it without a charge showing up yet, roll forward once.
    if (next < todayMs - freq.tol * DAY) {
      next = freq.key === 'monthly' ? nextMonthly(next, dom) : next + Math.round(freq.days) * DAY;
    }

    streams.push({
      merchant_key: g.key,
      name: g.name,
      category: g.category,
      frequency: freq.key,
      occurrences: days.length,
      confidence: days.length >= 3 ? 'established' : 'early',
      typical_amount: Math.round(typicalAmount * 100) / 100,
      amount_spread: typicalAmount ? (Math.max(...amounts) - Math.min(...amounts)) / typicalAmount : 0,
      day_of_month: freq.key === 'monthly' ? dom : null,
      day_spread: Math.max(...doms) - Math.min(...doms),
      last_date: fmt(last),
      predicted_next: fmt(next),
    });
  }
  return streams;
}

function patternType(name) {
  const p = BILL_MERCHANT_PATTERNS.find(x => x.pattern.test(name || ''));
  return p ? p.type : null;
}

/**
 * Which bucket a stream belongs in. A remembered user answer always wins.
 * @param {object} stream from detectStreams
 * @param {{bucket?: string, is_disabled?: boolean}|undefined} pref bill_preferences row
 */
function bucketFor(stream, pref) {
  if (pref && pref.bucket) return pref.bucket;
  if (pref && pref.is_disabled) return 'habit'; // older "stop auto-tasks" switch

  const t = patternType(stream.name);
  if (t === 'subscription') return 'subscription';
  if (t) return 'obligation'; // utility / insurance / rent / loan

  const [primary = '', detailed = ''] = String(stream.category || '').split('/');
  if (OBLIGATION_PRIMARY.has(primary) || OBLIGATION_DETAILED.test(detailed)) return 'obligation';
  if (SUBSCRIPTION_DETAILED.test(detailed)) return 'subscription';

  const fixedDayMonthly = stream.frequency === 'monthly' && stream.day_spread <= 4;
  const fixedAmount = stream.amount_spread <= 0.1;
  if (HABIT_PRIMARY.has(primary)) {
    // e.g. a gym or meal-kit plan billed on the same day for the same amount
    return fixedDayMonthly && fixedAmount ? 'unsure' : 'habit';
  }
  if (stream.frequency === 'weekly' || stream.frequency === 'biweekly') return 'habit';
  return fixedDayMonthly || stream.frequency === 'quarterly' || stream.frequency === 'annual' ? 'unsure' : 'habit';
}

/**
 * Obligations whose next date falls in the reminder window, and that are
 * trustworthy enough to remind about (established pattern, or a clear
 * obligation category on just two charges: day-one history after connecting).
 */
function remindersDue(streams, prefsByKey, todayMs) {
  const until = todayMs + REMIND_LEAD_DAYS * DAY;
  return streams
    .map(s => ({ ...s, bucket: bucketFor(s, prefsByKey.get(s.merchant_key)) }))
    .filter(s => s.bucket === 'obligation')
    .filter(s => {
      const next = toDay(s.predicted_next);
      return next >= todayMs && next <= until;
    });
}

/**
 * Did a requested cancellation work? Bank data decides, never the request:
 *   'charged_again'  an outflow from that merchant landed after the request day
 *   'confirmed'      no such charge, and we're past the expected charge date plus
 *                    the cadence tolerance and a few days of posting lag
 *   null             still too early to tell
 * @param {{merchant_key, cancel_requested_at, cancel_expected_by, cancel_frequency}} pref
 * @param {Array} txs outflows (getRecentOutflows)
 */
const POSTING_LAG_DAYS = 3;
function cancellationVerdict(pref, txs, todayMs) {
  const requestedDay = toDay(pref.cancel_requested_at);
  const chargedAfter = txs.some(t =>
    Number(t.amount) > 0 && t.transaction_date &&
    normalizeMerchantKey((t.merchant_name || t.description || '').trim()) === pref.merchant_key &&
    toDay(t.transaction_date) > requestedDay);
  if (chargedAfter) return 'charged_again';
  if (!pref.cancel_expected_by) return null;
  const freq = FREQUENCIES.find(f => f.key === pref.cancel_frequency);
  const graceDays = (freq ? freq.tol : 4) + POSTING_LAG_DAYS;
  return todayMs > toDay(pref.cancel_expected_by) + graceDays * DAY ? 'confirmed' : null;
}

/** Settle pending cancellations for one user. @returns {Promise<{confirmed:number, chargedAgain:number}>} */
async function verifyCancellations(pool, userId, txs, prefs, todayMs, db) {
  const out = { confirmed: 0, chargedAgain: 0 };
  for (const p of prefs) {
    if (p.cancel_status !== 'pending' || !p.cancel_requested_at) continue;
    const verdict = cancellationVerdict(p, txs, todayMs);
    if (!verdict) continue;
    if (await db.resolveCancellation(pool, userId, p.merchant_key, verdict)) {
      if (verdict === 'confirmed') out.confirmed++; else out.chargedAgain++;
      console.log(`[BillGuardian] cancellation ${verdict} | user: ${userId} | merchant: ${p.merchant_key}`);
    }
  }
  return out;
}

/**
 * Annual and quarterly subscriptions renewing in the next week that still
 * deserve a "still worth it?" heads-up: not being cancelled, and not already
 * reviewed and kept in the last 90 days (the same rest the Home card uses).
 * Monthly/weekly ones don't get a push; they recur too often to be worth one.
 */
const HEADS_UP_FREQUENCIES = new Set(['annual', 'quarterly']);
const HEADS_UP_DAYS = 7;
const KEEP_REST_MS = 90 * DAY;
function renewalHeadsUps(streams, prefsByKey, todayMs) {
  return streams
    .map(s => ({ ...s, bucket: bucketFor(s, prefsByKey.get(s.merchant_key)) }))
    .filter(s => s.bucket === 'subscription' && HEADS_UP_FREQUENCIES.has(s.frequency))
    .filter(s => {
      const next = toDay(s.predicted_next);
      return next > todayMs && next <= todayMs + HEADS_UP_DAYS * DAY;
    })
    .filter(s => {
      const pref = prefsByKey.get(s.merchant_key) || {};
      if (pref.cancel_status === 'pending' || pref.cancel_status === 'confirmed') return false;
      return !(pref.kept_at && todayMs - new Date(pref.kept_at).getTime() < KEEP_REST_MS);
    });
}

const money = (n) => '$' + Number(n).toFixed(Number(n) % 1 ? 2 : 0);
const shortDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function reminderTask(stream, balanceNote) {
  const when = stream.day_of_month ? `usually around the ${ordinal(stream.day_of_month)}` : `every ${stream.frequency.replace('ly', '')}`;
  const lines = [
    `Predicted from your last ${stream.occurrences} payments (${when}, about ${money(stream.typical_amount)}).`,
    "On autopay? Then this is just a heads-up to make sure the money's there.",
  ];
  if (balanceNote) lines.push(balanceNote);
  return {
    title: `${stream.name} due ${shortDate(stream.predicted_next)} (~${money(stream.typical_amount)})`,
    description: lines.join(' '),
    due_date: stream.predicted_next,
  };
}

function headsUpMessage(stream, todayMs) {
  const days = Math.round((toDay(stream.predicted_next) - todayMs) / DAY);
  const when = days <= 1 ? 'tomorrow' : `in ${days} days`;
  const per = stream.frequency === 'annual' ? 'a year' : 'a quarter';
  return {
    title: `${stream.name} renews ${when}`,
    body: `About ${money(stream.typical_amount)} ${per}. Still worth it? Keep it or cancel it in one tap.`,
    url: '/weightless',
  };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Run for one user: detect streams, create pre-due reminders for obligations
 * (once per predicted date), with a balance warning when what's due soon
 * exceeds what checking shows available.
 * @returns {Promise<{streams: number, reminders: number}>}
 */
async function runBillGuardian(pool, userId, { today = new Date(), db = require('../db/bills') } = {}) {
  const todayMs = toDay(today);
  const [txs, prefs] = await Promise.all([db.getRecentOutflows(pool, userId), db.getBillPreferences(pool, userId)]);
  const prefsByKey = new Map(prefs.map(p => [p.merchant_key, p]));
  const cancellations = await verifyCancellations(pool, userId, txs, prefs, todayMs, db);
  const streams = detectStreams(txs, todayMs);
  const due = remindersDue(streams, prefsByKey, todayMs);
  if (!due.length) return { streams: streams.length, reminders: 0, cancellations };

  let balanceNote = null;
  const available = await db.getAvailableCash(pool, userId);
  const dueTotal = due.reduce((sum, s) => sum + s.typical_amount, 0);
  if (available != null && dueTotal > available) {
    balanceNote = `Heads up: bills due in the next few days add up to about ${money(dueTotal)}, and your checking shows ${money(available)} available.`;
  }

  let created = 0;
  for (const s of due) {
    const task = reminderTask(s, balanceNote);
    const inserted = await db.createBillReminder(pool, userId, s, task);
    if (inserted) {
      created++;
      await db.trackRecurringMerchant(pool, userId, s);
    }
  }
  if (created) console.log(`[BillGuardian] ${created} pre-due reminder(s) | user: ${userId}`);
  return { streams: streams.length, reminders: created, cancellations };
}

module.exports = {
  REMIND_LEAD_DAYS,
  FREQUENCIES,
  detectStreams,
  cancellationVerdict,
  renewalHeadsUps,
  headsUpMessage,
  bucketFor,
  remindersDue,
  reminderTask,
  runBillGuardian,
  _internal: { nextMonthly, toDay, ordinal },
};
