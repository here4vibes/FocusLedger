'use strict';

jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn() }));
const { sendEmail } = require('../lib/emailService');
const { runEmailCrons } = require('../emailCron');

// Monday 2026-10-12 08:30 in America/New_York = 12:30 UTC
const MONDAY_8AM_NY = new Date('2026-10-12T12:30:00Z');
const user = { id: 7, email: 'u@example.com', name: null, timezone: 'America/New_York' };

function fakePool({ weekly = [], reengage = [], expiry = [] } = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (/JOIN app_subscription/.test(sql)) return { rows: weekly };
      if (/last_active_at IS NULL/.test(sql)) return { rows: reengage };
      if (/admin_pro_override = true/.test(sql)) return { rows: expiry };
      if (/FROM email_log/.test(sql)) return { rows: [] };
      if (/user_email_preferences/.test(sql)) return { rows: [] };
      if (/is_completed = false/.test(sql)) return { rows: [{ count: '3' }] };
      if (/is_completed = true/.test(sql)) return { rows: [{ count: '1' }] };
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: MONDAY_8AM_NY, doNotFake: ['nextTick', 'setImmediate'] });
  sendEmail.mockReset();
});
afterEach(() => jest.useRealTimers());

function sentHtml() { return sendEmail.mock.calls.map(c => c[1].subject + c[1].html + c[1].text).join('\n'); }

test('weekly nudge carries real counts — no "undefined tasks"', async () => {
  let resolveSend;
  sendEmail.mockReturnValue(new Promise(r => { resolveSend = r; }));
  const done = runEmailCrons(fakePool({ weekly: [user] }));
  // The cron must wait for the send (email_log is written inside it).
  await Promise.resolve(); await new Promise(r => setImmediate(r));
  let finished = false; done.then(() => { finished = true; });
  await new Promise(r => setImmediate(r));
  expect(finished).toBe(false);
  resolveSend({ success: true });
  await done;

  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][1].templateType).toBe('weekly_nudge');
  expect(sentHtml()).toMatch(/1 task\b/);
  expect(sentHtml()).toMatch(/3 tasks have a date this week/);
  expect(sentHtml()).not.toMatch(/undefined|null|NaN/);
});

test('re-engagement is shame-free and never prints undefined/null', async () => {
  sendEmail.mockResolvedValue({ success: true });
  await runEmailCrons(fakePool({ reengage: [user] }));
  const out = sentHtml();
  expect(out).not.toMatch(/undefined|null|We miss you|days since/i);
});

test('Pro expiry shows the date in the user timezone with checkout links', async () => {
  sendEmail.mockResolvedValue({ success: true });
  // 03:00 UTC on Oct 19 is still Oct 18 in New York
  await runEmailCrons(fakePool({ expiry: [{ ...user, pro_granted_until: '2026-10-19T03:00:00Z' }] }));
  const out = sentHtml();
  expect(out).toMatch(/October 18, 2026/);
  expect(out).toMatch(/buy\.stripe\.com/);
  expect(out).not.toMatch(/undefined/);
});
