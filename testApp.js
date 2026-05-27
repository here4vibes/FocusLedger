/**
 * Creates a minimal Express app for testing route modules
 * without DATABASE_URL or full server.js bootstrap.
 */
const express = require('express');

function createTestApp(pool, routeName) {
  const app = express();
  app.use(express.json());

  if (routeName === 'auth' || !routeName) {
    const authRoutes = require('../../routes/auth')(pool);
    app.use('/api/auth', authRoutes);
  }
  if (routeName === 'tasks' || !routeName) {
    const taskRoutes = require('../../routes/tasks')(pool);
    app.use('/api/tasks', taskRoutes);
  }
  if (routeName === 'expenses' || !routeName) {
    const expenseRoutes = require('../../routes/expenses')(pool);
    app.use('/api/expenses', expenseRoutes);
  }
  if (routeName === 'subscription' || !routeName) {
    const subscriptionRoutes = require('../../routes/subscription')(pool);
    app.use('/api/subscription', subscriptionRoutes);
  }
  if (routeName === 'values' || !routeName) {
    const valuesRoutes = require('../../routes/values')(pool);
    app.use('/api/values', valuesRoutes);
  }
  if (routeName === 'ideas' || !routeName) {
    const ideasRoutes = require('../../routes/ideas')(pool);
    app.use('/api/ideas', ideasRoutes);
  }
  if (routeName === 'ai-suggestions' || !routeName) {
    const aiSuggestionsRoutes = require('../../routes/ai-suggestions')(pool);
    app.use('/api/ai-suggestions', aiSuggestionsRoutes);
  }
  if (routeName === 'adhd-tax' || !routeName) {
    const adhdTaxRoutes = require('../../routes/adhd-tax')(pool);
    app.use('/api/adhd-tax', adhdTaxRoutes);
  }
  if (routeName === 'plaid' || !routeName) {
    const plaidRoutes = require('../../routes/plaid')(pool);
    app.use('/api/plaid', plaidRoutes);
  }
  if (routeName === 'recurring' || !routeName) {
    const recurringRoutes = require('../../routes/recurring')(pool);
    app.use('/api/recurring', recurringRoutes);
  }

  return app;
}

module.exports = { createTestApp };
