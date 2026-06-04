'use strict';

// queryWithRetry just delegates to pool.query in tests — retries are a no-op here.
jest.mock('../lib/queryWithRetry', () => ({
  queryWithRetry: jest.fn((pool, sql, params) => pool.query(sql, params)),
}));

const {
  createInvite,
  findPendingInvite,
  acceptInvite,
  getActivePartnership,
  dissolvePartnership,
  cancelPendingInvite,
  checkTandemAccess,
  activateTandemSubscription,
  activateTandemTrial,
  createPartnerConcern,
  getActiveConcernsAboutUser,
} = require('../db/partnerships');

// ── createInvite ──────────────────────────────────────────────────────────────
describe('createInvite', () => {
  test('inserts with a 48-char hex token and 7-day expiry', async () => {
    const row = { id: 1, invite_token: 'abc', invite_expires_at: new Date(), status: 'pending', created_at: new Date() };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const result = await createInvite(pool, 42);
    expect(result).toEqual(row);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(42); // inviterId
    const token = params[1];
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(48); // 24 bytes hex
    const expiresAt = params[2];
    const msIn7Days = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + msIn7Days - 60000);
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + msIn7Days + 60000);
  });
});

// ── findPendingInvite ─────────────────────────────────────────────────────────
describe('findPendingInvite', () => {
  test('returns null when no row found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await findPendingInvite(pool, 'bad-token')).toBeNull();
  });

  test('returns the invite row when found', async () => {
    const row = { id: 3, invite_token: 'good-token', status: 'pending', inviter_name: 'Alice' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    expect(await findPendingInvite(pool, 'good-token')).toEqual(row);
  });
});

// ── acceptInvite ──────────────────────────────────────────────────────────────
describe('acceptInvite', () => {
  test('returns null when UPDATE matches no rows (expired or wrong state)', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await acceptInvite(pool, 'expired-token', 5)).toBeNull();
  });

  test('returns the activated partnership row on success', async () => {
    const row = { id: 10, inviter_id: 1, invitee_id: 5, status: 'active', activated_at: new Date() };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const result = await acceptInvite(pool, 'valid-token', 5);
    expect(result).toEqual(row);
  });

  test('passes inviteeId to prevent self-invite acceptance', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await acceptInvite(pool, 'token', 7);
    const params = pool.query.mock.calls[0][1];
    expect(params[1]).toBe(7); // inviteeId appears twice — once for SET, once for WHERE inviter_id != $2
  });
});

// ── getActivePartnership ──────────────────────────────────────────────────────
describe('getActivePartnership', () => {
  test('returns null when user has no active partnership', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await getActivePartnership(pool, 1)).toBeNull();
  });

  test('returns the partnership row with partner info', async () => {
    const row = { id: 5, status: 'active', partner_id: 2, partner_name: 'Bob', partner_email: 'bob@ex.com' };
    const pool = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    expect(await getActivePartnership(pool, 1)).toEqual(row);
  });
});

// ── dissolvePartnership ───────────────────────────────────────────────────────
describe('dissolvePartnership', () => {
  test('returns false when no active partnership found for user', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await dissolvePartnership(pool, 99, 1)).toBe(false);
  });

  test('returns true when the partnership is dissolved', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 4 }] }) };
    expect(await dissolvePartnership(pool, 4, 1)).toBe(true);
  });

  test('scopes the update to the requesting userId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await dissolvePartnership(pool, 10, 7);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe(10); // partnershipId
    expect(params[1]).toBe(7);  // userId
  });
});

// ── cancelPendingInvite ───────────────────────────────────────────────────────
describe('cancelPendingInvite', () => {
  test('returns false when no pending invite exists', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await cancelPendingInvite(pool, 1)).toBe(false);
  });

  test('returns true when invite is cancelled', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 2 }] }) };
    expect(await cancelPendingInvite(pool, 1)).toBe(true);
  });
});

// ── checkTandemAccess ─────────────────────────────────────────────────────────
describe('checkTandemAccess', () => {
  test('returns { hasTandem: false, reason: "none" } when user not found', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await checkTandemAccess(pool, 999);
    expect(result.hasTandem).toBe(false);
    expect(result.reason).toBe('none');
  });

  test('returns { hasTandem: true, reason: "paid" } for active own subscription', async () => {
    const expires = new Date(Date.now() + 86400000); // +1 day
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ tandem_plan: 'tandem', tandem_expires_at: expires, tandem_trial_started_at: null }]
      })
    };
    const result = await checkTandemAccess(pool, 1);
    expect(result.hasTandem).toBe(true);
    expect(result.reason).toBe('paid');
  });

  test('returns { hasTandem: false } for expired own subscription', async () => {
    const expired = new Date(Date.now() - 86400000); // -1 day
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ tandem_plan: 'tandem', tandem_expires_at: expired }] })
        .mockResolvedValueOnce({ rows: [] }) // no active partnership
    };
    const result = await checkTandemAccess(pool, 1);
    expect(result.hasTandem).toBe(false);
  });

  test('returns { hasTandem: true, reason: "trial" } when trial is active', async () => {
    const trialStarted = new Date(Date.now() - 5 * 86400000); // started 5 days ago
    const expires = new Date(Date.now() + 86400000);
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ tandem_plan: null, tandem_expires_at: null }] })
        .mockResolvedValueOnce({ rows: [{
          tandem_trial_activated_at: trialStarted,
          partner_tandem_plan: null,
          partner_tandem_expires_at: null,
        }] })
    };
    const result = await checkTandemAccess(pool, 1);
    expect(result.hasTandem).toBe(true);
    expect(result.reason).toBe('trial');
  });

  test('returns { hasTandem: true, reason: "partner_paid" } when partner has subscription', async () => {
    const partnerExpires = new Date(Date.now() + 86400000);
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ tandem_plan: null, tandem_expires_at: null }] })
        .mockResolvedValueOnce({ rows: [{
          tandem_trial_activated_at: null,
          partner_tandem_plan: 'tandem',
          partner_tandem_expires_at: partnerExpires,
        }] })
    };
    const result = await checkTandemAccess(pool, 1);
    expect(result.hasTandem).toBe(true);
    expect(result.reason).toBe('partner_paid');
  });
});

// ── createPartnerConcern ──────────────────────────────────────────────────────
describe('createPartnerConcern', () => {
  test('marks old concerns consumed then inserts a new one', async () => {
    const newConcern = { id: 1, concern_text: 'stressed', topic_area: 'work' };
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // mark old consumed
        .mockResolvedValueOnce({ rows: [newConcern] }) // insert
    };
    const result = await createPartnerConcern(pool, 1, 2, 3, 'stressed about work', 'work');
    expect(result).toEqual(newConcern);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE partner_concerns.*is_consumed = TRUE/s);
  });

  test('truncates concern_text to 500 chars', async () => {
    const longText = 'x'.repeat(600);
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] })
    };
    await createPartnerConcern(pool, 1, 2, 3, longText, 'stress');
    const insertParams = pool.query.mock.calls[1][1];
    expect(insertParams[3]).toHaveLength(500);
  });
});

// ── getActiveConcernsAboutUser ────────────────────────────────────────────────
describe('getActiveConcernsAboutUser', () => {
  test('returns topic_area rows — never concern_text', async () => {
    const rows = [{ id: 1, topic_area: 'work', created_at: new Date() }];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) };
    const result = await getActiveConcernsAboutUser(pool, 5);
    expect(result).toEqual(rows);
    // Verify the SELECT does NOT include concern_text
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/concern_text/);
    expect(sql).toMatch(/topic_area/);
  });

  test('scopes query to aboutUserId', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await getActiveConcernsAboutUser(pool, 7);
    expect(pool.query.mock.calls[0][1][0]).toBe(7);
  });
});

// ── activateTandemSubscription ────────────────────────────────────────────────
describe('activateTandemSubscription', () => {
  test('updates user tandem_plan and grants trial to active partner', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const expires = new Date(Date.now() + 365 * 86400000);
    await activateTandemSubscription(pool, 1, expires);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql1, params1] = pool.query.mock.calls[0];
    expect(sql1).toMatch(/UPDATE users/);
    expect(sql1).toMatch(/tandem_plan = 'tandem'/);
    expect(params1[0]).toBe(1);
  });
});
