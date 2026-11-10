'use strict';
const { parseDueDate } = require('../lib/nl-due-date');

const NY = 'America/New_York';
// Tue 2026-10-20 10:00 in New York (14:00 UTC).
const TUE_MORNING = new Date('2026-10-20T14:00:00Z');
// Tue 2026-10-20 22:30 in New York, already Wed 2026-10-21 02:30 in UTC.
const TUE_LATE = new Date('2026-10-21T02:30:00Z');

describe('parseDueDate', () => {
  test('no date in the text returns it unchanged', () => {
    expect(parseDueDate('buy milk', NY, TUE_MORNING))
      .toEqual({ title: 'buy milk', due_date: null, due_time: null, matched: null });
  });

  test('empty or non-string input is returned unchanged', () => {
    expect(parseDueDate('', NY, TUE_MORNING).due_date).toBeNull();
    expect(parseDueDate(null, NY, TUE_MORNING).due_date).toBeNull();
  });

  test('"tomorrow" strips the phrase and sets the next local day', () => {
    expect(parseDueDate('call mom tomorrow', NY, TUE_MORNING))
      .toMatchObject({ title: 'call mom', due_date: '2026-10-21', due_time: null });
  });

  test('weekday + time: "dentist Tuesday 3pm" later today is today', () => {
    expect(parseDueDate('dentist Tuesday 3pm', NY, TUE_MORNING))
      .toMatchObject({ title: 'dentist', due_date: '2026-10-20', due_time: '15:00' });
  });

  test('weekday + time already past this week rolls to next week', () => {
    expect(parseDueDate('dentist Tuesday 3pm', NY, TUE_LATE))
      .toMatchObject({ title: 'dentist', due_date: '2026-10-27', due_time: '15:00' });
  });

  test('weekday with a connector: "submit report by Friday"', () => {
    expect(parseDueDate('submit report by Friday', NY, TUE_MORNING))
      .toMatchObject({ title: 'submit report', due_date: '2026-10-23', due_time: null });
  });

  test('relative days: "gym in 3 days"', () => {
    expect(parseDueDate('gym in 3 days', NY, TUE_MORNING))
      .toMatchObject({ title: 'gym', due_date: '2026-10-23' });
  });

  test('day of month: "pay rent on the 1st" is the next 1st', () => {
    expect(parseDueDate('pay rent on the 1st', NY, TUE_MORNING))
      .toMatchObject({ title: 'pay rent', due_date: '2026-11-01', due_time: null });
  });

  test('day of month later this month stays in this month', () => {
    expect(parseDueDate('pay rent the 25th', NY, TUE_MORNING))
      .toMatchObject({ title: 'pay rent', due_date: '2026-10-25' });
  });

  test('times: am/pm, noon, and bare hours read as afternoon', () => {
    expect(parseDueDate('meeting next friday at 10am', NY, TUE_MORNING))
      .toMatchObject({ title: 'meeting', due_date: '2026-10-30', due_time: '10:00' });
    expect(parseDueDate('Lunch with Ana Oct 30 at noon', NY, TUE_MORNING))
      .toMatchObject({ title: 'Lunch with Ana', due_date: '2026-10-30', due_time: '12:00' });
    expect(parseDueDate('pick up kids at 3', NY, TUE_MORNING))
      .toMatchObject({ title: 'pick up kids', due_date: '2026-10-20', due_time: '15:00' });
  });

  test('time only that has passed today lands tomorrow', () => {
    expect(parseDueDate('take meds at 8am', NY, TUE_MORNING))
      .toMatchObject({ title: 'take meds', due_date: '2026-10-21', due_time: '08:00' });
  });

  test('timezone: late evening in New York uses the New York date, not UTC', () => {
    // UTC already says Wed 10-21; New York is still Tue 10-20.
    expect(parseDueDate('call mom tomorrow', NY, TUE_LATE).due_date).toBe('2026-10-21');
    expect(parseDueDate('call mom tomorrow', 'UTC', TUE_LATE).due_date).toBe('2026-10-22');
    expect(parseDueDate('call bob tonight', NY, TUE_LATE).due_date).toBe('2026-10-20');
  });

  test('timezone: Tokyo morning is a day ahead of UTC', () => {
    // 2026-10-20 23:30 UTC = Wed 2026-10-21 08:30 in Tokyo.
    const t = new Date('2026-10-20T23:30:00Z');
    expect(parseDueDate('dentist tomorrow', 'Asia/Tokyo', t).due_date).toBe('2026-10-22');
  });

  test('words that only look like dates are left alone', () => {
    for (const s of ['fix the sat nav', 'email Sun Life', 'March for science',
      'order the 2nd monitor', 'do it now', 'Call Dr. May at 9', 'Read 1 chapter']) {
      expect(parseDueDate(s, NY, TUE_MORNING)).toMatchObject({ title: s, due_date: null });
    }
  });

  test('a date-only title keeps its text as the title', () => {
    expect(parseDueDate('tomorrow', NY, TUE_MORNING))
      .toMatchObject({ title: 'tomorrow', due_date: '2026-10-21' });
  });
});
