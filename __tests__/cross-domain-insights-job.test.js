'use strict';

const { fetchUserData, summariseForPrompt } = require('../jobs/crossDomainInsightsJob');

describe('crossDomainInsightsJob', () => {
  test('check-in query reads energy_level, never the non-existent mood column (NODE-EXPRESS-6)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await fetchUserData(pool, 2, '2026-10-01');
    const checkinSql = pool.query.mock.calls.map(c => c[0]).find(sql => /FROM buddy_checkins/.test(sql));
    expect(checkinSql).toMatch(/\benergy_level\b/);
    expect(checkinSql).not.toMatch(/\bmood\b/);
  });

  test('summary lists logged energy levels and skips check-ins without one', () => {
    const text = summariseForPrompt({
      tasks: [],
      expenses: [],
      focus: [],
      checkins: [
        { checkin_type: 'morning', energy_level: 'low', checkin_date: '2026-10-09' },
        { checkin_type: 'morning', energy_level: null, checkin_date: '2026-10-08' },
        { checkin_type: 'evening', energy_level: 'high', checkin_date: '2026-10-08' },
      ],
    });
    expect(text).toContain('CHECK-INS (last 7 days): 2 morning, 1 evening');
    expect(text).toContain('Energy levels logged: low, high');
    expect(text).not.toMatch(/mood/i);
  });

  test('no energy line when none were logged', () => {
    const text = summariseForPrompt({
      tasks: [], expenses: [], focus: [],
      checkins: [{ checkin_type: 'morning', energy_level: null }],
    });
    expect(text).not.toContain('Energy levels logged');
  });
});
