'use strict';

const { _internal: { yahooListMessages } } = require('../routes/email');

function fakeImapFlow({ exists = 30, messages = [], logoutFails = false } = {}) {
  const calls = { options: null, fetchRange: null, lock: null, released: false, loggedOut: false, closed: false };
  class FakeImapFlow {
    constructor(options) { calls.options = options; this.mailbox = null; }
    async connect() {}
    async getMailboxLock(path, opts) {
      calls.lock = { path, opts };
      this.mailbox = { exists };
      return { release: () => { calls.released = true; } };
    }
    async *fetch(range) { calls.fetchRange = range; for (const m of messages) yield m; }
    async logout() { calls.loggedOut = true; if (logoutFails) throw new Error('bye failed'); }
    close() { calls.closed = true; }
  }
  return { FakeImapFlow, calls };
}

test('authenticates with the OAuth token, keeps TLS verification on, reads INBOX read-only', async () => {
  const { FakeImapFlow, calls } = fakeImapFlow({ exists: 0 });
  await yahooListMessages('me@yahoo.com', 'tok', { ImapFlow: FakeImapFlow });
  expect(calls.options).toMatchObject({ host: 'imap.mail.yahoo.com', port: 993, secure: true, auth: { user: 'me@yahoo.com', accessToken: 'tok' } });
  expect(calls.options.tls).toBeUndefined(); // no rejectUnauthorized:false
  expect(calls.lock).toEqual({ path: 'INBOX', opts: { readOnly: true } });
  expect(calls.released).toBe(true);
  expect(calls.loggedOut).toBe(true);
});

test('fetches the newest 25 and maps them to the shared inbox shape, newest first', async () => {
  const { FakeImapFlow, calls } = fakeImapFlow({
    exists: 30,
    messages: [
      { seq: 6, uid: 106, flags: new Set(['\\Seen']), envelope: { messageId: '<a@x>', subject: 'Older', from: [{ name: 'Ann', address: 'ann@x.com' }], date: new Date('2026-10-07T10:00:00Z') } },
      { seq: 30, uid: 130, flags: new Set(), envelope: { subject: '', from: [{ address: 'bob@x.com' }], date: null } },
    ],
  });
  const out = await yahooListMessages('me@yahoo.com', 'tok', { ImapFlow: FakeImapFlow });

  expect(calls.fetchRange).toBe('6:30');
  expect(out[0]).toEqual({ seqno: 30, uid: 130, id: 'yahoo-seq-30', subject: '(no subject)', from: 'bob@x.com', from_name: '', date: '', snippet: '', flags: [] });
  expect(out[1]).toMatchObject({ id: '<a@x>', subject: 'Older', from: 'ann@x.com', from_name: 'Ann', date: '2026-10-07T10:00:00.000Z', flags: ['\\Seen'] });
});

test('a failed logout closes the socket and is logged, results still returned', async () => {
  const { FakeImapFlow, calls } = fakeImapFlow({ exists: 1, messages: [{ seq: 1, uid: 1, envelope: { subject: 's' } }], logoutFails: true });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const out = await yahooListMessages('me@yahoo.com', 'tok', { ImapFlow: FakeImapFlow });
  expect(out).toHaveLength(1);
  expect(calls.closed).toBe(true);
  expect(spy).toHaveBeenCalledWith('[email/yahoo] IMAP logout failed:', 'bye failed');
  spy.mockRestore();
});
