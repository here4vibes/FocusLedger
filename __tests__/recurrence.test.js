'use strict';
// Run the whole file with a DST-observing process clock, so any accidental use
// of local-time Date math (the old bug class) shows up around DST changes.
process.env.TZ = 'America/New_York';

const {
  nextTaskOccurrence, nextScheduleDate, toYmd, takesRecurrenceDay, TASK_RECURRENCE_TYPES,
} = require('../lib/recurrence');

const next = (o) => {
  const r = nextTaskOccurrence(o);
  return r && r.due_date;
};

describe('toYmd', () => {
  test('accepts raw DATE strings and ISO timestamps', () => {
    expect(toYmd('2026-10-21')).toBe('2026-10-21');
    expect(toYmd('2026-10-21T00:00:00.000Z')).toBe('2026-10-21');
  });
  test('reads node-pg style local-midnight Date objects by their calendar fields', () => {
    expect(toYmd(new Date(2026, 2, 8))).toBe('2026-03-08'); // US DST starts that day
    expect(toYmd(new Date(2026, 10, 1))).toBe('2026-11-01'); // US DST ends that day
  });
  test('rejects junk and impossible dates', () => {
    expect(toYmd(null)).toBeNull();
    expect(toYmd('')).toBeNull();
    expect(toYmd('tomorrow')).toBeNull();
    expect(toYmd('2026-02-31')).toBeNull();
    expect(toYmd(new Date('nope'))).toBeNull();
  });
});

describe('nextTaskOccurrence: types and inputs', () => {
  test('none, unknown types and missing due dates do not repeat', () => {
    expect(nextTaskOccurrence({ type: 'none', from: '2026-10-21' })).toBeNull();
    expect(nextTaskOccurrence({ type: 'hourly', from: '2026-10-21' })).toBeNull();
    expect(nextTaskOccurrence({ type: undefined, from: '2026-10-21' })).toBeNull();
    expect(nextTaskOccurrence({ type: 'daily', from: null })).toBeNull();
  });

  test('daily', () => {
    expect(next({ type: 'daily', from: '2026-10-21' })).toBe('2026-10-22');
    expect(next({ type: 'daily', from: '2026-12-31' })).toBe('2027-01-01');
  });

  test('weekdays skip the weekend', () => {
    expect(next({ type: 'weekdays', from: '2026-10-21' })).toBe('2026-10-22'); // Wed → Thu
    expect(next({ type: 'weekdays', from: '2026-10-23' })).toBe('2026-10-26'); // Fri → Mon
    expect(next({ type: 'weekdays', from: '2026-10-24' })).toBe('2026-10-26'); // Sat → Mon
  });

  test('takesRecurrenceDay matches the types that use recurrence_day', () => {
    expect(TASK_RECURRENCE_TYPES.filter(takesRecurrenceDay)).toEqual(['weekly', 'biweekly', 'monthly']);
  });
});

describe('weekly on specific weekdays', () => {
  test('same weekday as the due date → one week later', () => {
    expect(next({ type: 'weekly', day: 3, from: '2026-10-21' })).toBe('2026-10-28'); // Wed
  });
  test('a later weekday in the same week', () => {
    expect(next({ type: 'weekly', day: 5, from: '2026-10-21' })).toBe('2026-10-23'); // Wed → Fri
  });
  test('an earlier weekday wraps into next week', () => {
    expect(next({ type: 'weekly', day: 1, from: '2026-10-21' })).toBe('2026-10-26'); // Wed → Mon
    expect(next({ type: 'weekly', day: 0, from: '2026-10-21' })).toBe('2026-10-25'); // Wed → Sun
  });
  test('recurrence_day stored as TEXT (prod) works the same', () => {
    expect(next({ type: 'weekly', day: '1', from: '2026-10-21' })).toBe('2026-10-26');
  });
  test('no recurrence_day → the due date\'s weekday, and it is pinned', () => {
    expect(nextTaskOccurrence({ type: 'weekly', day: null, from: '2026-10-21' }))
      .toEqual({ due_date: '2026-10-28', recurrence_day: 3 });
  });
  test('an out-of-range recurrence_day falls back to the due date\'s weekday', () => {
    expect(next({ type: 'weekly', day: 9, from: '2026-10-21' })).toBe('2026-10-28');
  });
});

describe('every other week (biweekly)', () => {
  test('same weekday → two weeks later', () => {
    expect(next({ type: 'biweekly', day: 3, from: '2026-10-21' })).toBe('2026-11-04');
  });
  test('defaults to the due date\'s weekday', () => {
    expect(next({ type: 'biweekly', from: '2026-10-23' })).toBe('2026-11-06');
  });
  test('catching up keeps the every-other-week rhythm', () => {
    // Due Oct 7 (Wed), finished on Oct 21 → next is Oct 21 itself (on the cadence),
    // not Oct 28 (off-cadence).
    expect(next({ type: 'biweekly', day: 3, from: '2026-10-07', tz: 'UTC', now: new Date('2026-10-21T12:00:00Z') }))
      .toBe('2026-10-21');
    expect(next({ type: 'biweekly', day: 3, from: '2026-10-07', tz: 'UTC', now: new Date('2026-10-22T12:00:00Z') }))
      .toBe('2026-11-04');
  });
});

describe('month-end', () => {
  test('Jan 31 → Feb 28 (not Mar 3)', () => {
    expect(next({ type: 'monthly', day: 31, from: '2026-01-31' })).toBe('2026-02-28');
  });
  test('Jan 31 → Feb 29 in a leap year', () => {
    expect(next({ type: 'monthly', day: 31, from: '2028-01-31' })).toBe('2028-02-29');
  });
  test('Feb 28 → Mar 31 for a series on the 31st (no drift)', () => {
    expect(next({ type: 'monthly', day: '31', from: '2026-02-28' })).toBe('2026-03-31');
  });
  test('Mar 31 → Apr 30', () => {
    expect(next({ type: 'monthly', day: 31, from: '2026-03-31' })).toBe('2026-04-30');
  });
  test('the 30th → Feb 28 → Mar 30', () => {
    expect(next({ type: 'monthly', day: 30, from: '2026-01-30' })).toBe('2026-02-28');
    expect(next({ type: 'monthly', day: 30, from: '2026-02-28' })).toBe('2026-03-30');
  });
  test('monthly with no recurrence_day pins the due date\'s day, so the series keeps it', () => {
    const first = nextTaskOccurrence({ type: 'monthly', day: null, from: '2026-01-31' });
    expect(first).toEqual({ due_date: '2026-02-28', recurrence_day: 31 });
    const second = nextTaskOccurrence({ type: 'monthly', day: first.recurrence_day, from: first.due_date });
    expect(second.due_date).toBe('2026-03-31');
  });
  test('a later day this month comes before next month', () => {
    expect(next({ type: 'monthly', day: 20, from: '2026-10-05' })).toBe('2026-10-20');
  });
  test('year rollover', () => {
    expect(next({ type: 'monthly', day: 15, from: '2026-12-15' })).toBe('2027-01-15');
  });
});

describe('last weekday of the month', () => {
  test('Oct 30 2026 (Fri) → Nov 30 2026 (Mon)', () => {
    expect(next({ type: 'monthly_last_weekday', from: '2026-10-30' })).toBe('2026-11-30');
  });
  test('skips a month ending on a weekend: Jan 2027 ends Sunday → Fri Jan 29', () => {
    expect(next({ type: 'monthly_last_weekday', from: '2026-12-31' })).toBe('2027-01-29');
  });
  test('a mid-month due date goes to this month\'s last weekday', () => {
    expect(next({ type: 'monthly_last_weekday', from: '2026-05-10' })).toBe('2026-05-29'); // May 31 is a Sunday
  });
  test('recurrence_day is ignored', () => {
    expect(nextTaskOccurrence({ type: 'monthly_last_weekday', day: 5, from: '2026-10-30' }))
      .toEqual({ due_date: '2026-11-30', recurrence_day: null });
  });
});

describe('DST changes (process clock is America/New_York)', () => {
  test('daily across spring-forward and fall-back stays one calendar day', () => {
    expect(next({ type: 'daily', from: '2026-03-07' })).toBe('2026-03-08');
    expect(next({ type: 'daily', from: '2026-03-08' })).toBe('2026-03-09');
    expect(next({ type: 'daily', from: '2026-10-31' })).toBe('2026-11-01');
    expect(next({ type: 'daily', from: '2026-11-01' })).toBe('2026-11-02');
  });
  test('weekly across both transitions stays on the same weekday', () => {
    expect(next({ type: 'weekly', day: 4, from: '2026-03-05' })).toBe('2026-03-12');
    expect(next({ type: 'weekly', day: 4, from: '2026-10-29' })).toBe('2026-11-05');
  });
  test('a node-pg local-midnight Date on the DST day works as input', () => {
    expect(next({ type: 'daily', from: new Date(2026, 2, 8) })).toBe('2026-03-09');
    expect(next({ type: 'weekdays', from: new Date(2026, 10, 1) })).toBe('2026-11-02');
  });
  test('the user-local "today" is right on a DST morning', () => {
    // 2026-03-08 06:30 UTC = 01:30 EST, still Mar 8 locally.
    expect(next({ type: 'daily', from: '2026-03-01', tz: 'America/New_York', now: new Date('2026-03-08T06:30:00Z') }))
      .toBe('2026-03-08');
  });
});

describe('timezone where the local date differs from UTC', () => {
  // 2026-10-21 02:00 UTC is still Oct 20 in Los Angeles, already Oct 21 in Auckland afternoon.
  const now = new Date('2026-10-21T02:00:00Z');

  test('a task finished late never comes back already overdue (local today, not UTC)', () => {
    expect(next({ type: 'daily', from: '2026-10-01', tz: 'America/Los_Angeles', now })).toBe('2026-10-20');
    expect(next({ type: 'daily', from: '2026-10-01', tz: 'UTC', now })).toBe('2026-10-21');
  });
  test('ahead of UTC: Auckland is already on the 22nd', () => {
    const late = new Date('2026-10-21T12:00:00Z'); // Oct 22 01:00 in Auckland
    expect(next({ type: 'daily', from: '2026-10-21', tz: 'Pacific/Auckland', now: late })).toBe('2026-10-22');
    expect(next({ type: 'daily', from: '2026-10-20', tz: 'Pacific/Auckland', now: late })).toBe('2026-10-22');
  });
  test('on-time completion is unaffected: due today → tomorrow', () => {
    expect(next({ type: 'daily', from: '2026-10-20', tz: 'America/Los_Angeles', now })).toBe('2026-10-21');
  });
  test('weekly catch-up lands on the next matching weekday from local today', () => {
    // Local today is Tue Oct 20 in LA; weekly on Monday from Sep 28 → Mon Oct 26.
    expect(next({ type: 'weekly', day: 1, from: '2026-09-28', tz: 'America/Los_Angeles', now })).toBe('2026-10-26');
  });
  test('a future due date is not pulled back to today', () => {
    expect(next({ type: 'weekly', day: 1, from: '2026-11-02', tz: 'America/Los_Angeles', now })).toBe('2026-11-09');
  });
});

describe('nextScheduleDate (recurring_tasks / recurring_expenses templates)', () => {
  test('day and week cadences match the old fixed steps', () => {
    expect(nextScheduleDate('2026-10-21', 'daily')).toBe('2026-10-22');
    expect(nextScheduleDate('2026-10-21', 'weekly')).toBe('2026-10-28');
    expect(nextScheduleDate('2026-10-21', 'biweekly')).toBe('2026-11-04');
    expect(nextScheduleDate('2026-10-21', 'something-else')).toBe('2026-10-28'); // old default
  });
  test('monthly keeps the start date\'s day through short months', () => {
    expect(nextScheduleDate('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28');
    expect(nextScheduleDate('2026-02-28', 'monthly', '2026-01-31')).toBe('2026-03-31');
    expect(nextScheduleDate('2026-04-30', 'monthly', '2026-01-31')).toBe('2026-05-31');
  });
  test('a fromDate that does not fit the start date wins (e.g. edited schedule)', () => {
    expect(nextScheduleDate('2026-03-14', 'monthly', '2026-01-10')).toBe('2026-04-14');
  });
  test('quarterly and yearly clamp month ends and leap days', () => {
    expect(nextScheduleDate('2026-11-30', 'quarterly', '2026-08-31')).toBe('2027-02-28');
    expect(nextScheduleDate('2024-02-29', 'yearly', '2024-02-29')).toBe('2025-02-28');
    expect(nextScheduleDate('2027-02-28', 'yearly', '2024-02-29')).toBe('2028-02-29');
  });
  test('Date objects and bad input', () => {
    expect(nextScheduleDate(new Date(2026, 0, 31), 'monthly')).toBe('2026-02-28');
    expect(nextScheduleDate('not a date', 'monthly')).toBeNull();
  });
});
