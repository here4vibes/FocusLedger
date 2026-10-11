'use strict';

jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../db/tandem-recap', () => ({ getActivePartnerPairs: jest.fn(), wasSentOnLocalDate: jest.fn(), getWeekTogether: jest.fn() }));

const { sendEmail } = require('../lib/emailService');
const db = require('../db/tandem-recap');
const { tandemRecapTemplate, sendTandemRecaps } = require('../lib/tandem-recap');

const MONDAY_8AM_NY = new Date('2026-10-12T12:30:00Z');
const person = (id, name, extra = {}) => ({ id, name, email: `${id}@x.com`, timezone: 'America/New_York', is_qa_user: false, opted_out: false, ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  sendEmail.mockResolvedValue({ success: true });
  db.wasSentOnLocalDate.mockResolvedValue(false);
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

test('quiet week → no email at all (nobody is told they did nothing)', () => {
  expect(tandemRecapTemplate({ name: 'A', partnerName: 'B', together: 0, sharedWins: [] })).toBeNull();
});

test('combined count only, shared titles escaped, opt-out footer present', () => {
  const t = tandemRecapTemplate({ name: 'Ana Lopez', partnerName: 'Ben Smith', together: 1, sharedWins: ['<script>x</script>'] });
  expect(t.subject).toBe('You and Ben finished 1 thing this week');
  expect(t.html).not.toMatch(/<script>/);
  expect(t.html).toMatch(/no more/);
  expect(t.html + t.text).not.toMatch(/\bvs\b|more than|less than|only/i);
});

test('sends to both partners at their Monday 8am, skipping QA, opted-out and already-sent', async () => {
  db.getActivePartnerPairs.mockResolvedValue([
    { id: 1, a: person(1, 'Ana'), b: person(2, 'Ben') },
    { id: 2, a: person(3, 'Cal', { opted_out: true }), b: person(4, 'Dee', { is_qa_user: true }) },
  ]);
  db.getWeekTogether.mockResolvedValue({ together: 2, sharedWins: ['Groceries'] });
  db.wasSentOnLocalDate.mockImplementation(async (_p, userId) => userId === 2);
  const r = await sendTandemRecaps({}, MONDAY_8AM_NY);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][1]).toMatchObject({ to: '1@x.com', templateType: 'tandem_recap', userId: 1 });
  expect(r).toEqual({ sent: 1, skipped: 2 });
});

test('outside Monday 8am local → nothing is sent', async () => {
  db.getActivePartnerPairs.mockResolvedValue([{ id: 1, a: person(1, 'Ana'), b: person(2, 'Ben') }]);
  await sendTandemRecaps({}, new Date('2026-10-12T15:30:00Z')); // 11:30 NY
  expect(sendEmail).not.toHaveBeenCalled();
});
