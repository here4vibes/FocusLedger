'use strict';

const { detectStreams, bucketFor, remindersDue, reminderTask, runBillGuardian } = require('../lib/bill-guardian');

const DAY = 86400000;
const TODAY = Date.parse('2026-10-11T12:00:00Z');
const d = (offsetDays) => new Date(TODAY + offsetDays * DAY).toISOString().slice(0, 10);
// `months` charges on day `dom`, the most recent one on or before TODAY.
const monthly = (name, dom, amount, months, category) => {
  const lastMonth = new Date(TODAY).getUTCDate() >= dom ? 9 : 8; // Oct if already passed, else Sep
  return Array.from({ length: months }, (_, i) => {
    const dt = new Date(Date.UTC(2026, lastMonth - (months - 1 - i), dom, 12));
    return { merchant_name: name, amount, transaction_date: dt.toISOString().slice(0, 10), plaid_category: category };
  });
};
const every = (name, gapDays, amount, count, category, startOffset = -2) =>
  Array.from({ length: count }, (_, i) => ({ merchant_name: name, amount: typeof amount === 'function' ? amount(i) : amount, transaction_date: d(startOffset - i * gapDays), plaid_category: category }));

const find = (streams, name) => streams.find(s => s.name === name);

test('rent: monthly on the 1st, predicted for next month, an obligation', () => {
  const s = find(detectStreams(monthly('Oak Property Management', 1, 1850, 4, 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_RENT'), TODAY), 'Oak Property Management');
  expect(s).toMatchObject({ frequency: 'monthly', occurrences: 4, confidence: 'established', predicted_next: '2026-11-01', day_of_month: 1 });
  expect(bucketFor(s)).toBe('obligation');
});

test('nails every ~3 weeks: recurring but a habit, never reminded', () => {
  const txs = every('Glow Nails', 21, (i) => [55, 62, 48, 70][i], 4, 'PERSONAL_CARE/PERSONAL_CARE_HAIR_AND_BEAUTY');
  const streams = detectStreams(txs, TODAY);
  // 21-day cadence doesn't match a billing frequency at all
  expect(find(streams, 'Glow Nails')).toBeUndefined();
});

test('nails monthly but varying day/amount → habit; same day + same amount → ask', () => {
  const varying = [d(-5), d(-37), d(-63)].map((dt, i) => ({ merchant_name: 'Glow Nails', amount: [55, 70, 48][i], transaction_date: dt, plaid_category: 'PERSONAL_CARE/PERSONAL_CARE_HAIR_AND_BEAUTY' }));
  const sv = find(detectStreams(varying, TODAY), 'Glow Nails');
  expect(sv && bucketFor(sv)).toBe('habit');
  const fixed = monthly('Glow Nails Club', 15, 45, 3, 'PERSONAL_CARE/PERSONAL_CARE_HAIR_AND_BEAUTY');
  expect(bucketFor(find(detectStreams(fixed, TODAY), 'Glow Nails Club'))).toBe('unsure');
});

test('Netflix → subscription (merchant pattern), not reminded', () => {
  const s = find(detectStreams(monthly('Netflix', 9, 15.49, 3, 'ENTERTAINMENT/ENTERTAINMENT_TV_AND_MOVIES'), TODAY), 'Netflix');
  expect(bucketFor(s)).toBe('subscription');
});

test('weekly coffee with varying amounts → habit', () => {
  const s = find(detectStreams(every('Blue Bottle', 7, (i) => 4 + i, 6, 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE'), TODAY), 'Blue Bottle');
  expect(s.frequency).toBe('weekly');
  expect(bucketFor(s)).toBe('habit');
});

test('quarterly insurance → obligation with a predicted date ~91 days on', () => {
  const s = find(detectStreams(every('State Farm', 91, 310, 3, 'GENERAL_SERVICES/GENERAL_SERVICES_INSURANCE', -80), TODAY), 'State Farm');
  expect(s.frequency).toBe('quarterly');
  expect(bucketFor(s)).toBe('obligation');
});

test('day-one history: two charges of a clear obligation is enough ("early")', () => {
  const s = find(detectStreams(monthly('Chase Card Payment', 20, 240, 2, 'LOAN_PAYMENTS/LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'), TODAY), 'Chase Card Payment');
  expect(s).toMatchObject({ confidence: 'early', predicted_next: '2026-10-20' });
  expect(bucketFor(s)).toBe('obligation');
});

test('a remembered answer always wins', () => {
  const s = find(detectStreams(monthly('Oak Property Management', 1, 1850, 3, 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_RENT'), TODAY), 'Oak Property Management');
  expect(bucketFor(s, { bucket: 'habit' })).toBe('habit');
  expect(bucketFor(s, { is_disabled: true })).toBe('habit');
});

test('stopped streams are dropped (no charge for over two cycles)', () => {
  const old = monthly('Old Gym', 3, 40, 3, 'PERSONAL_CARE/PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS').map(t => ({ ...t, transaction_date: new Date(Date.parse(t.transaction_date) - 120 * DAY).toISOString().slice(0, 10) }));
  expect(find(detectStreams(old, TODAY), 'Old Gym')).toBeUndefined();
});

test('reminders: only obligations due within 3 days, dated the due day (not after paying)', () => {
  const txs = [
    ...monthly('City Water Utility', 13, 62, 3, 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_WATER'), // next Oct 13 → within 3 days
    ...monthly('Oak Property Management', 1, 1850, 3, 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_RENT'), // next Nov 1 → too far
    ...monthly('Netflix', 12, 15.49, 3, 'ENTERTAINMENT/ENTERTAINMENT_TV_AND_MOVIES'), // subscription → never
  ];
  const due = remindersDue(detectStreams(txs, TODAY), new Map(), TODAY);
  expect(due.map(s => s.name)).toEqual(['City Water Utility']);
  const task = reminderTask(due[0], null);
  expect(task.due_date).toBe('2026-10-13');
  expect(task.title).toBe('City Water Utility due Oct 13 (~$62)');
  expect(task.description).toMatch(/last 3 payments \(usually around the 13th, about \$62\)/);
});

test('runBillGuardian: creates once, adds a balance warning when due bills exceed cash', async () => {
  const created = [];
  const db = {
    getRecentOutflows: async () => [
      ...monthly('City Water Utility', 13, 62, 3, 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_WATER'),
      ...monthly('Ally Auto Loan', 12, 410, 3, 'LOAN_PAYMENTS/LOAN_PAYMENTS_CAR_PAYMENT'),
    ],
    getBillPreferences: async () => [],
    getAvailableCash: async () => 300,
    createBillReminder: async (_p, _u, stream, task) => { created.push(task); return true; },
    trackRecurringMerchant: async () => {},
  };
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const r = await runBillGuardian({}, 7, { today: new Date(TODAY), db });
  log.mockRestore();
  expect(r.reminders).toBe(2);
  expect(created[0].description).toMatch(/add up to about \$472, and your checking shows \$300 available/);
});
