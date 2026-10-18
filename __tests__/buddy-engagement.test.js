'use strict';

jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../lib/apns-sender', () => ({ isApnsConfigured: () => false, sendApnsNotification: jest.fn() }));
jest.mock('../db/notifications', () => ({
  getActiveSubscriptions: jest.fn().mockResolvedValue([]),
  recordNotificationSent: jest.fn(),
  wasNotificationSentToday: jest.fn().mockResolvedValue(false),
  deleteSubscriptionByEndpoint: jest.fn(),
}));
jest.mock('../db/push-tokens', () => ({ getPushTokens: jest.fn().mockResolvedValue([]), deletePushToken: jest.fn() }));

const { sendEmail } = require('../lib/emailService');
const { _internal: { processUser, daysBetween } } = require('../buddyEngagementCron');

const TZ = 'America/New_York';
// 10:00 New York on 2026-10-08 = 14:00 UTC
const TEN_AM = new Date('2026-10-08T14:00:00Z');
const HALF_PAST_MIDNIGHT = new Date('2026-10-08T04:30:00Z');

function pool() {
  const upserts = [];
  return {
    upserts,
    query: jest.fn(async (sql, params) => {
      if (/INSERT INTO buddy_engagement/.test(sql)) {
        const fields = sql.match(/\(user_id, ([^)]*), updated_at\)/)[1].split(', ');
        upserts.push(Object.fromEntries(fields.map((f, i) => [f, params[i + 1]])));
      }
      return { rows: [] }; // no check-ins anywhere
    }),
  };
}
function user(eng = {}) {
  return { id: 9, email: 'u@example.com', name: 'Sam', timezone: TZ, engagement: eng };
}

beforeEach(() => {
  sendEmail.mockReset();
  process.env.RESEND_API_KEY = 're_test';
});
afterAll(() => { delete process.env.RESEND_API_KEY; });

test('daysBetween counts calendar days', () => {
  expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
  expect(daysBetween('2026-10-08', '2026-10-08')).toBe(0);
});

test('nothing is processed (or sent) overnight; it waits for the daytime window', async () => {
  const p = pool();
  expect(await processUser(p, user(), HALF_PAST_MIDNIGHT)).toBe(false);
  expect(p.upserts).toHaveLength(0);
});

test('lapse day = consecutive local days: first miss is day 1, not day 0/2', async () => {
  const p = pool();
  await processUser(p, user(), TEN_AM);
  expect(p.upserts[0].consecutive_missed_checkins).toBe(1);
  expect(p.upserts[0].lapse_push_sent).toBe(false);
});

test('day 5: email is sent and the flag set only after a confirmed send', async () => {
  sendEmail.mockResolvedValue({ success: true });
  const p = pool();
  // lapse first recorded 4 local days ago → today is day 5
  await processUser(p, user({ lapse_started_at: '2026-10-04T14:00:00Z', lapse_push_sent: true, consecutive_missed_checkins: 1 }), TEN_AM);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][1].templateType).toBe('buddy_reengage_day5');
  expect(sendEmail.mock.calls[0][1].html).not.toMatch(/undefined/);
  expect(p.upserts[0].lapse_day5_email_sent).toBe(true);
});

test('day 4 sends nothing (old off-by-one would have counted this as day 5)', async () => {
  const p = pool();
  await processUser(p, user({ lapse_started_at: '2026-10-05T14:00:00Z', lapse_push_sent: true }), TEN_AM);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(p.upserts[0].lapse_day5_email_sent).toBe(false);
});

test('failed send leaves the flag false so tomorrow retries', async () => {
  sendEmail.mockResolvedValue({ success: false, error: 'resend down' });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const p = pool();
  await processUser(p, user({ lapse_started_at: '2026-10-04T14:00:00Z', lapse_push_sent: true }), TEN_AM);
  expect(p.upserts[0].lapse_day5_email_sent).toBe(false);
  spy.mockRestore();
});
