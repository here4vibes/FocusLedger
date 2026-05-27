'use strict';

/**
 * Integration tests for routes/tasks.js
 * Covers: CRUD, step-toggle regression, 10-task free tier limit.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-focusledger';

const request = require('supertest');
const { createTestApp } = require('./helpers/testApp');
const { generateToken } = require('../middleware/auth');

// Auth token for a free user (no Pro)
function makeToken(userId = 1) {
  return generateToken({ id: userId, email: `user${userId}@test.com`, name: 'Test' });
}

// ────────────────────────────────────────────────────────────────
// POST /api/tasks — create task
// ────────────────────────────────────────────────────────────────
describe('POST /api/tasks', () => {
  test('401 without auth token', async () => {
    const pool = { query: jest.fn() };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app).post('/api/tasks').send({ title: 'Do something' });
    expect(res.status).toBe(401);
  });

  test('400 when title is missing', async () => {
    // checkIsPro queries: admin_pro_override + subscription
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] }) // checkIsPro - user
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] }) // checkIsPro - sub
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
  });

  test('201 creates task for free user with < 10 active tasks', async () => {
    const taskRow = { id: 10, title: 'Buy milk', user_id: 1, is_completed: false, description: null, priority: 'medium', due_date: null };
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })    // checkIsPro - user
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] }) // checkIsPro - sub
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })                    // active task count
        .mockResolvedValueOnce({ rows: [{ id: 10, title: 'Buy milk', steps: [] }] }), // fetch full task (post-commit)
      connect: jest.fn().mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({})              // BEGIN
          .mockResolvedValueOnce({ rows: [taskRow] }) // INSERT task
          .mockResolvedValueOnce({}),             // COMMIT
        release: jest.fn()
      })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Buy milk' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test('402 when free user has 10 active tasks (task limit reached)', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: false }] })     // checkIsPro - user
        .mockResolvedValueOnce({ rows: [{ plan: 'free', status: 'active' }] }) // checkIsPro - sub
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })                    // active task count (AT limit)
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'One too many' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('TASK_LIMIT_REACHED');
    expect(res.body.upgrade_required).toBe(true);
  });

  test('Pro user (admin_pro_override) bypasses 10-task limit', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ admin_pro_override: true }] })  // checkIsPro short-circuits
        // No task count check for Pro
        .mockResolvedValueOnce({ rows: [{ id: 20, title: 'Task 11', user_id: 2, is_completed: false, description: null, priority: 'medium', due_date: null }] }), // fetch full
      connect: jest.fn().mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({})  // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 20, title: 'Task 11', user_id: 2, is_completed: false, description: null, priority: 'medium', due_date: null }] })
          .mockResolvedValueOnce({}), // COMMIT
        release: jest.fn()
      })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${makeToken(2)}`)
      .send({ title: 'Task 11' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id/toggle — toggle task completion
// ────────────────────────────────────────────────────────────────
describe('PATCH /api/tasks/:id/toggle', () => {
  test('toggles task to completed', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1, is_completed: true, completed_at: new Date() }] }) // UPDATE tasks
        .mockResolvedValueOnce({ rows: [] }) // UPDATE task_steps (auto-complete all)
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/1/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.task.is_completed).toBe(true);
  });

  test('404 when task not found', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/999/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// REGRESSION: PATCH /api/tasks/:taskId/steps/:stepId/toggle
// Completing step 2 should NOT affect step 1 or step 3.
// ────────────────────────────────────────────────────────────────
describe('PATCH /api/tasks/:taskId/steps/:stepId/toggle — regression', () => {
  test('toggles only the target step (step 2 of 3)', async () => {
    // Set up a task with 3 steps: step 1 completed, step 2 not, step 3 not
    const step2Updated = { id: 2, task_id: 10, title: 'Step 2', is_completed: true, completed_at: new Date(), sort_order: 1 };

    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 10 }] })          // task ownership check
        .mockResolvedValueOnce({ rows: [step2Updated] })         // UPDATE step 2 only
        .mockResolvedValueOnce({ rows: [{ total: '3', done: '2' }] }) // step count — not all done yet
        .mockResolvedValueOnce({ rows: [] })                    // uncomplete task if needed (not called since done<total)
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/10/steps/2/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Only step 2 was returned — other steps untouched
    expect(res.body.step.id).toBe(2);
    expect(res.body.step.is_completed).toBe(true);

    // Verify the UPDATE query targeted step 2 specifically (id = $1)
    const updateCall = pool.query.mock.calls[1]; // second call is the step UPDATE
    expect(updateCall[1]).toEqual(['2', '10']); // stepId=2, taskId=10
  });

  test('auto-completes parent task when all steps are done', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 10 }] })          // task ownership check
        .mockResolvedValueOnce({ rows: [{ id: 3, task_id: 10, title: 'Step 3', is_completed: true, completed_at: new Date(), sort_order: 2 }] }) // UPDATE step 3
        .mockResolvedValueOnce({ rows: [{ total: '3', done: '3' }] }) // all steps done
        .mockResolvedValueOnce({ rows: [] })                    // UPDATE tasks SET is_completed=true
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/10/steps/3/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);

    // The 4th query should be the task auto-complete
    const taskCompleteCall = pool.query.mock.calls[3];
    expect(taskCompleteCall[0]).toMatch(/UPDATE tasks SET is_completed = true/);
  });

  test('unchecking a step uncompletes parent task', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, task_id: 10, is_completed: false, completed_at: null }] }) // unchecked step 1
        .mockResolvedValueOnce({ rows: [{ total: '3', done: '1' }] }) // not all done (done < total)
        .mockResolvedValueOnce({ rows: [] }) // UPDATE tasks SET is_completed=false
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/10/steps/1/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);

    // The 4th query should uncomplete the parent task
    const uncompleteCall = pool.query.mock.calls[3];
    expect(uncompleteCall[0]).toMatch(/is_completed = false/);
  });

  test('404 when step not found', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 10 }] }) // task found
        .mockResolvedValueOnce({ rows: [] })            // step not found
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .patch('/api/tasks/10/steps/999/toggle')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/tasks/:id
// ────────────────────────────────────────────────────────────────
describe('DELETE /api/tasks/:id', () => {
  test('deletes task successfully', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 5 }] })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .delete('/api/tasks/5')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('404 when task not found or not owned by user', async () => {
    const pool = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] })
    };
    const app = createTestApp(pool, 'tasks');

    const res = await request(app)
      .delete('/api/tasks/999')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});
