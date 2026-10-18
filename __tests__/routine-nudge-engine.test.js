'use strict';

const { checkAndGenerateNudges, routineNudgeMessage } = require('../lib/routineNudgeEngine');

test('message avoids "routine routine" and stays gentle', () => {
  expect(routineNudgeMessage('Morning routine')).toBe('"Morning routine" is ready when you are.');
  expect(routineNudgeMessage('Weekly review')).toBe('Your "Weekly review" routine is ready when you are.');
  expect(routineNudgeMessage(null)).toMatch(/your routine/);
});

test('query is gated on the user-local hour, weekday, active flag, completion and prefs', async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  // Thursday 2026-10-08 07:00 in New York
  await checkAndGenerateNudges(pool, 5, '2026-10-08', 'America/New_York', new Date('2026-10-08T11:00:00Z'));
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/nudge_after_hour <= \$2/);
  expect(sql).toMatch(/is_active/);
  expect(sql).toMatch(/routine_streaks/);
  expect(sql).toMatch(/routine_nudge_prefs/);
  // routines.day_of_week is INTEGER 0-6 (Sunday = 0) since the counter-columns migration.
  expect(sql).toMatch(/day_of_week IS NULL OR r\.day_of_week = \$3/);
  expect(params).toEqual([5, 7, 4, '2026-10-08']);
});
