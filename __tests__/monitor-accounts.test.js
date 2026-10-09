'use strict';

const { isMonitorEmail } = require('../lib/monitor-accounts');

test.each([
  ['signup-monitor+gh-123-1@focusledger.net', true],
  ['SIGNUP-MONITOR+local1@FocusLedger.net', true],
  ['signup-monitor@focusledger.net', false],          // tag required
  ['signup-monitor+x@evil.com', false],                // only our domain
  ['signup-monitor+x@focusledger.net.evil.com', false],
  ['real.person@example.com', false],
  [null, false],
])('%s → %s', (email, expected) => {
  expect(isMonitorEmail(email)).toBe(expected);
});
