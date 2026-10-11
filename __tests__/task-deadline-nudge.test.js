'use strict';

const mockWebpush = { sendNotification: jest.fn().mockResolvedValue({}) };
jest.mock('../lib/webpush', () => ({ configureWebPush: () => ({ webpush: mockWebpush, apnsEnabled: false, anyConfigured: true }) }));
jest.mock('../lib/apns-sender', () => ({ sendApnsNotification: jest.fn() }));
jest.mock('../db/push-tokens', () => ({ getPushTokens: jest.fn().mockResolvedValue([]), deletePushToken: jest.fn() }));
jest.mock('../db/notifications', () => ({
  DAILY_PUSH_CAP: 3,
  wasNotificationSentToday: jest.fn().mockResolvedValue(false),
  getTodayNotificationCount: jest.fn().mockResolvedValue(0),
  recordNotificationSent: jest.fn().mockResolvedValue(undefined),
  getActiveSubscriptions: jest.fn().mockResolvedValue([{ subscription: { endpoint: 'e' }, endpoint: 'e' }]),
  deleteSubscriptionByEndpoint: jest.fn(),
}));

const notifications = require('../db/notifications');
const { sendTaskDeadlineNudges, _internal: { buildDeadlineBody } } = require('../taskDeadlineNudge');

const TZ = 'America/New_York';
function pool(tasks) {
  return {
    query: jest.fn(async (sql) => {
      if (/FROM users u/.test(sql)) return { rows: [{ id: 1, timezone: TZ }] };
      return { rows: tasks };
    }),
  };
}
const at = (iso) => new Date(iso);

beforeEach(() => {
  mockWebpush.sendNotification.mockClear();
  notifications.recordNotificationSent.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); console.log.mockRestore(); });

function run(nowIso, tasks) {
  jest.useFakeTimers({ now: at(nowIso), doNotFake: ['nextTick', 'setImmediate'] });
  return sendTaskDeadlineNudges(pool(tasks));
}
function body() { return JSON.parse(mockWebpush.sendNotification.mock.calls[0][1]).body; }

const overdueYesterday = { id: 't1', title: 'Pay rent', due_day: '2026-10-07', due_time: null, due_at: '2026-10-08T03:59:59Z' };

test('no pushes overnight (00:30 local)', async () => {
  await run('2026-10-08T04:30:00Z', [overdueYesterday]);
  expect(mockWebpush.sendNotification).not.toHaveBeenCalled();
});

test('daytime: overdue task nudged with its title', async () => {
  await run('2026-10-08T14:00:00Z', [overdueYesterday]);
  expect(body()).toBe('"Pay rent" — still waiting');
  expect(notifications.recordNotificationSent).toHaveBeenCalledWith(expect.anything(), 1, 'task:t1', 'task_deadline', '2026-10-08');
});

test('more than 3 days overdue → no more pushes', async () => {
  await run('2026-10-08T14:00:00Z', [{ ...overdueYesterday, due_day: '2026-10-04', due_at: '2026-10-05T03:59:59Z' }]);
  expect(mockWebpush.sendNotification).not.toHaveBeenCalled();
});

test('untimed task due today is not "almost time" at 23:00 — waits until it is actually past', async () => {
  // 21:30 local, task due today with no time
  await run('2026-10-09T01:30:00Z', [{ id: 't2', title: 'Call mom', due_day: '2026-10-08', due_time: null, due_at: '2026-10-09T03:59:59Z' }]);
  expect(mockWebpush.sendNotification).not.toHaveBeenCalled();
});

test('mixed push names the lead task and counts the rest it records', () => {
  expect(buildDeadlineBody([
    { title: 'Pay rent', type: 'overdue' }, { title: 'A', type: '1h' }, { title: 'B', type: '1h' },
  ])).toBe('"Pay rent" and 2 more need you today');
});

test('null and very long titles are safe', () => {
  expect(buildDeadlineBody([{ title: null, type: '1h' }])).toBe('"A task" — almost time');
  expect(buildDeadlineBody([{ title: 'x'.repeat(200), type: '1h' }]).length).toBeLessThan(80);
});
