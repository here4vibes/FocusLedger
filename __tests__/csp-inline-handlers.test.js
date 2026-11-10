'use strict';
// Pages use inline onclick/onchange handlers (Settings "Invite a Partner",
// plan buttons, the ADHD Tax Calculator…). Helmet's default
// script-src-attr 'none' blocked all of them without any visible error.

const express = require('express');
const request = require('supertest');
const { helmetMiddleware } = require('../middleware/security');

test('CSP allows inline event handlers (script-src-attr)', async () => {
  const app = express();
  app.use(helmetMiddleware);
  app.get('/', (_req, res) => res.send('ok'));
  const res = await request(app).get('/');
  const csp = res.headers['content-security-policy'];
  expect(csp).toMatch(/script-src-attr 'unsafe-inline'/);
  expect(csp).not.toMatch(/script-src-attr 'none'/);
});
