// @ts-check
/**
 * Focus Mode idle detection, end to end at phone width (375px).
 * The page's clock is faked (page.clock), and "the user left" is simulated by
 * flipping document.visibilityState and firing visibilitychange.
 */
const { test, expect } = require('@playwright/test');

let token;
let user;

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/auth/signup', {
    data: {
      email: `focus-idle-${Date.now()}@example.com`,
      password: 'F0cusIdle!pw',
      name: 'Focus Idle',
      timezone: 'America/New_York',
    },
  });
  expect(r.ok(), `signup failed: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  token = body.token;
  user = body.user || {};
});

async function newTask(request, title) {
  const r = await request.post('/api/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title },
  });
  expect(r.status(), `create task: ${await r.text()}`).toBe(201);
  return (await r.json()).task.id;
}

async function latestSession(request, taskId) {
  const r = await request.get('/api/v1/focus-sessions/recent', { headers: { Authorization: `Bearer ${token}` } });
  const { sessions } = await r.json();
  return sessions.find(s => s.task_id === taskId);
}

async function setVisibility(page, state) {
  await page.evaluate((st) => {
    Object.defineProperty(document, 'visibilityState', { value: st, configurable: true });
    Object.defineProperty(document, 'hidden', { value: st === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function openFocus(page, taskId) {
  // Frozen clock: only runFor/fastForward move time, so counts are exact.
  await page.clock.install({ time: new Date('2026-10-21T14:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-21T14:00:01Z'));
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('fl_token', t);
    localStorage.setItem('fl_user', JSON.stringify(u));
  }, [token, user]);
  await page.goto(`/app/focus/${taskId}`);
  await expect(page.locator('#focus-app')).toBeVisible();
  await expect(page.locator('#timer-display')).toHaveText('25:00');
}

/** Open Focus Mode for a new task, focus for 1 minute, then leave for 12. */
async function focusThenLeave(page, request, title) {
  const taskId = await newTask(request, title);
  await openFocus(page, taskId);

  await page.clock.runFor(60 * 1000);
  await expect(page.locator('#timer-display')).toHaveText('24:00');

  await setVisibility(page, 'hidden');
  await page.clock.fastForward('12:00');
  await setVisibility(page, 'visible');

  await expect(page.locator('#away-prompt')).toBeVisible();
  await expect(page.locator('#away-duration')).toHaveText('12 min');
  // The timer waited at the moment the user left.
  await expect(page.locator('#timer-display')).toHaveText('24:00');
  await expect(page.locator('#timer-sublabel')).toHaveText('paused');
  return taskId;
}

function completeRequest(page) {
  return page.waitForRequest(r => /\/focus-sessions\/[^/]+\/complete$/.test(r.url()));
}

test('count it as focus: the 12 minutes are added to the session', async ({ page, request }) => {
  const taskId = await focusThenLeave(page, request, 'Idle focus choice');
  await page.getByRole('button', { name: 'Count it as focus' }).click();
  await expect(page.locator('#away-prompt')).toBeHidden();
  await expect(page.locator('#timer-display')).toHaveText('12:00');

  const req = completeRequest(page);
  await page.locator('#btn-skip').click();
  expect((await req).postDataJSON()).toEqual({ actual_duration_seconds: 60 + 12 * 60, completed: false });
  await expect.poll(async () => (await latestSession(request, taskId))?.actual_duration_seconds).toBe(780);
});

test('take it as a break: the timer resumes and the break is not focus', async ({ page, request }) => {
  const taskId = await focusThenLeave(page, request, 'Idle break choice');
  await page.getByRole('button', { name: 'Take it as a break' }).click();
  await expect(page.locator('#away-prompt')).toBeHidden();
  await expect(page.locator('#timer-display')).toHaveText('24:00');
  await expect(page.locator('#timer-sublabel')).toHaveText('remaining');

  // Back at work for 30 more seconds.
  await page.clock.runFor(30 * 1000);
  await expect(page.locator('#timer-display')).toHaveText('23:30');

  const req = completeRequest(page);
  await page.locator('#btn-skip').click();
  expect((await req).postDataJSON()).toEqual({ actual_duration_seconds: 90, completed: false });
  await expect.poll(async () => (await latestSession(request, taskId))?.actual_duration_seconds).toBe(90);
});

test('end session: stops with only the focus before leaving', async ({ page, request }) => {
  const taskId = await focusThenLeave(page, request, 'Idle end choice');
  const req = completeRequest(page);
  await page.getByRole('button', { name: 'End session' }).click();
  expect((await req).postDataJSON()).toEqual({ actual_duration_seconds: 60, completed: false });
  await expect.poll(async () => {
    const s = await latestSession(request, taskId);
    return s && { secs: s.actual_duration_seconds, completed: s.completed, ended: !!s.ended_at };
  }).toEqual({ secs: 60, completed: false, ended: true });
});

test('visible but untouched for 5 minutes also counts as away', async ({ page, request }) => {
  const taskId = await newTask(request, 'Idle visible');
  await openFocus(page, taskId);

  await page.clock.runFor(4 * 60 * 1000 + 58 * 1000);
  await expect(page.locator('#away-prompt')).toBeHidden();
  await page.clock.runFor(3 * 1000);
  await expect(page.locator('#away-prompt')).toBeVisible();
  await expect(page.locator('#away-duration')).toHaveText('5 min');
  // Rolled back to the last sign of the user (page load).
  await expect(page.locator('#timer-display')).toHaveText('25:00');
});
