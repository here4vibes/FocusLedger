'use strict';

const { renewalHeadsUps, headsUpMessage } = require('../lib/bill-guardian');

const DAY = 86400000;
const day = (s) => Date.parse(s + 'T12:00:00Z');
const today = day('2026-10-11');
const stream = (over) => ({ merchant_key: 'amazon_prime', name: 'Amazon Prime', category: null,
  frequency: 'annual', typical_amount: 139, amount_spread: 0, day_spread: 0, predicted_next: '2026-10-15', ...over });
const prefs = (rows) => new Map(rows.map(r => [r.merchant_key, r]));
const sub = { merchant_key: 'amazon_prime', bucket: 'subscription' };

describe('renewalHeadsUps', () => {
  test('annual subscription renewing within a week gets a heads-up', () => {
    expect(renewalHeadsUps([stream()], prefs([sub]), today)).toHaveLength(1);
  });
  test('quarterly counts; monthly and weekly do not', () => {
    expect(renewalHeadsUps([stream({ frequency: 'quarterly' })], prefs([sub]), today)).toHaveLength(1);
    expect(renewalHeadsUps([stream({ frequency: 'monthly' })], prefs([sub]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream({ frequency: 'weekly' })], prefs([sub]), today)).toHaveLength(0);
  });
  test('outside the 7-day window, or today, is skipped', () => {
    expect(renewalHeadsUps([stream({ predicted_next: '2026-10-19' })], prefs([sub]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream({ predicted_next: '2026-10-11' })], prefs([sub]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream({ predicted_next: '2026-10-18' })], prefs([sub]), today)).toHaveLength(1);
  });
  test('bills and habits never get one', () => {
    expect(renewalHeadsUps([stream()], prefs([{ ...sub, bucket: 'obligation' }]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream()], prefs([{ ...sub, bucket: 'habit' }]), today)).toHaveLength(0);
  });
  test('being cancelled, or kept in the last 90 days, suppresses it', () => {
    expect(renewalHeadsUps([stream()], prefs([{ ...sub, cancel_status: 'pending' }]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream()], prefs([{ ...sub, kept_at: new Date(today - 30 * DAY) }]), today)).toHaveLength(0);
    expect(renewalHeadsUps([stream()], prefs([{ ...sub, kept_at: new Date(today - 120 * DAY) }]), today)).toHaveLength(1);
  });
  test('message names the service, timing and yearly cost', () => {
    const m = headsUpMessage(stream({ predicted_next: '2026-10-12' }), today);
    expect(m.title).toBe('Amazon Prime renews tomorrow');
    expect(m.body).toMatch(/\$139 a year/);
    expect(m.url).toBe('/weightless');
  });
});

describe('renewalHeadsUpJob.runForUser', () => {
  jest.resetModules();
  const billsDb = require('../db/bills');
  const notif = require('../db/notifications');
  const tz = require('../lib/timezone');
  const { runForUser } = require('../jobs/renewalHeadsUpJob');

  const txs = ['2024-10-15', '2025-10-15'].map(d => ({ merchant_name: 'Amazon Prime', amount: 139, transaction_date: d }));
  let sent, logged;
  beforeEach(() => {
    sent = []; logged = new Set();
    jest.spyOn(tz, 'fetchUserTimezone').mockResolvedValue('America/New_York');
    jest.spyOn(tz, 'getUserLocalDate').mockReturnValue('2026-10-11');
    jest.spyOn(billsDb, 'getRecentOutflows').mockResolvedValue(txs);
    jest.spyOn(billsDb, 'getBillPreferences').mockResolvedValue([sub]);
    jest.spyOn(notif, 'wasNotificationKeySent').mockImplementation(async (p, u, k) => logged.has(k));
    jest.spyOn(notif, 'getTodayNotificationCount').mockResolvedValue(0);
    jest.spyOn(notif, 'recordNotificationSent').mockImplementation(async (p, u, k) => { logged.add(k); });
  });
  afterEach(() => jest.restoreAllMocks());
  const push = async (pool, userId, msg) => { sent.push(msg); };
  const at = (iso) => new Date(iso);

  test('sends at 10am local, once per renewal', async () => {
    // 14:00 UTC = 10:00 New York (EDT)
    expect(await runForUser({}, 7, { now: at('2026-10-11T14:05:00Z'), push })).toBe(1);
    expect(sent[0].title).toMatch(/Amazon Prime renews in 4 days/);
    expect(await runForUser({}, 7, { now: at('2026-10-11T14:30:00Z'), push })).toBe(0);
    expect(sent).toHaveLength(1);
  });
  test('does nothing outside the send hour', async () => {
    expect(await runForUser({}, 7, { now: at('2026-10-11T06:00:00Z'), push })).toBe(0);
    expect(sent).toHaveLength(0);
  });
  test('respects the daily push cap', async () => {
    notif.getTodayNotificationCount.mockResolvedValue(notif.DAILY_PUSH_CAP);
    expect(await runForUser({}, 7, { now: at('2026-10-11T14:05:00Z'), push })).toBe(0);
  });
});

describe('detectStreams history windows', () => {
  const { detectStreams } = require('../lib/bill-guardian');
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  test('an annual subscription is found from two charges a year apart', () => {
    const txs = [today - 361 * DAY, today - 726 * DAY].map(d => ({ merchant_name: 'Amazon Prime', amount: 139, transaction_date: iso(d) }));
    const [s] = detectStreams(txs, today);
    expect(s).toMatchObject({ frequency: 'annual', merchant_key: 'amazon_prime' });
    expect(s.predicted_next).toBe(iso(today + 4 * DAY));
  });
  test('monthly detection still ignores irregular charges older than ~13 months', () => {
    const recent = Array.from({ length: 12 }, (_, i) => today - (i * 30 + 5) * DAY);
    const oldOdd = [today - 450 * DAY, today - 470 * DAY, today - 520 * DAY]; // irregular, outside the short window
    const txs = recent.concat(oldOdd).map(d => ({ merchant_name: 'Spotify', amount: 11.99, transaction_date: iso(d) }));
    const [s] = detectStreams(txs, today);
    expect(s).toMatchObject({ frequency: 'monthly', occurrences: 12 });
  });
});
