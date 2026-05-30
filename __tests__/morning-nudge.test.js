'use strict';

// Mock all external deps before importing the module under test
jest.mock('../lib/timezone', () => ({
  getLocalDateParts: jest.fn(),
}));
jest.mock('../lib/apns-sender', () => ({
  isApnsConfigured: jest.fn(() => false),
  sendApnsNotification: jest.fn(),
}));
jest.mock('../db/push-tokens', () => ({
  getPushTokens: jest.fn(() => Promise.resolve([])),
  deletePushToken: jest.fn(),
}));
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
}), { virtual: true });

const { getLocalDateParts } = require('../lib/timezone');
const { isApnsConfigured } = require('../lib/apns-sender');
const { sendMorningNudges } = require('../morningNudge');

function makePool(users = [], additionalResponses = []) {
  let call = 0;
  const responses = [{ rows: users }, ...additionalResponses];
  return {
    query: jest.fn(async () => {
      const resp = responses[call] ?? { rows: [] };
      call++;
      return resp;
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: neither VAPID nor APNs configured → no sends
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  isApnsConfigured.mockReturnValue(false);
});

describe('sendMorningNudges — skipping logic', () => {
  test('exits immediately when neither web push nor APNs is configured', async () => {
    const pool = makePool([{ id: 1, timezone: 'America/New_York', notif_morning_enabled: true, notif_morning_hour: 8 }]);
    await sendMorningNudges(pool);
    // No pool queries at all — function returns early
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('skips user when notif_morning_enabled is false', async () => {
    isApnsConfigured.mockReturnValue(true);
    const user = { id: 1, timezone: 'UTC', last_active_at: null, notif_morning_enabled: false, notif_morning_hour: 8 };
    const pool = makePool([user]);
    getLocalDateParts.mockReturnValue({ date: '2026-05-30', hour: 8 });

    await sendMorningNudges(pool);

    // Should only have the initial users query — no per-user nudge queries
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('skips user when current hour does not match target hour', async () => {
    isApnsConfigured.mockReturnValue(true);
    const user = { id: 2, timezone: 'UTC', last_active_at: null, notif_morning_enabled: true, notif_morning_hour: 8 };
    const pool = makePool([user]);
    // Current hour is 10, not 8
    getLocalDateParts.mockReturnValue({ date: '2026-05-30', hour: 10 });

    await sendMorningNudges(pool);

    // Only the initial query runs; no per-user send queries
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('skips user when nudge was already sent today', async () => {
    isApnsConfigured.mockReturnValue(true);
    const user = { id: 3, timezone: 'UTC', last_active_at: null, notif_morning_enabled: true, notif_morning_hour: 8 };
    getLocalDateParts.mockReturnValue({ date: '2026-05-30', hour: 8 });

    // users query + already-sent log query (returns a row = already sent)
    const pool = makePool([user], [{ rows: [{ 1: 1 }] }]);

    await sendMorningNudges(pool);

    // Users query (1) + check morning_nudge_log (2). No further send queries.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('skips user who was already active today', async () => {
    isApnsConfigured.mockReturnValue(true);
    const user = {
      id: 4,
      timezone: 'UTC',
      last_active_at: new Date().toISOString(),
      notif_morning_enabled: true,
      notif_morning_hour: 8,
    };
    const todayDate = '2026-05-30';
    // Both the hour-check and last_active_at calls return the same localDate
    getLocalDateParts.mockReturnValue({ date: todayDate, hour: 8 });

    const pool = makePool([user], [
      { rows: [] }, // morning_nudge_log → not sent yet
    ]);

    await sendMorningNudges(pool);

    // Users query + log check — no send because last_active matches today
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('sendMorningNudges — send path (APNs only)', () => {
  const { getPushTokens } = require('../db/push-tokens');
  const { sendApnsNotification } = require('../lib/apns-sender');

  test('records the send when APNs delivers successfully', async () => {
    isApnsConfigured.mockReturnValue(true);
    sendApnsNotification.mockResolvedValue({ sent: 1, failed: 0 });
    getPushTokens.mockResolvedValue([{ token: 'device-token-abc' }]);

    const user = { id: 5, timezone: 'UTC', last_active_at: null, notif_morning_enabled: true, notif_morning_hour: 8 };
    getLocalDateParts.mockReturnValue({ date: '2026-05-30', hour: 8 });

    const pool = makePool([user], [
      { rows: [] }, // morning_nudge_log → not sent yet
      { rows: [] }, // INSERT into log
    ]);

    await sendMorningNudges(pool);

    expect(sendApnsNotification).toHaveBeenCalledTimes(1);
    // Log insert should have been called
    const logInsert = pool.query.mock.calls.find(([sql]) => /INSERT INTO morning_nudge_log/.test(sql));
    expect(logInsert).toBeDefined();
  });

  test('does NOT record a send when APNs returns sent=0', async () => {
    isApnsConfigured.mockReturnValue(true);
    sendApnsNotification.mockResolvedValue({ sent: 0, failed: 0 });
    getPushTokens.mockResolvedValue([{ token: 'token' }]);

    const user = { id: 6, timezone: 'UTC', last_active_at: null, notif_morning_enabled: true, notif_morning_hour: 8 };
    getLocalDateParts.mockReturnValue({ date: '2026-05-30', hour: 8 });

    const pool = makePool([user], [{ rows: [] }]);
    await sendMorningNudges(pool);

    const logInsert = pool.query.mock.calls.find(([sql]) => /INSERT INTO morning_nudge_log/.test(sql));
    expect(logInsert).toBeUndefined();
  });
});
