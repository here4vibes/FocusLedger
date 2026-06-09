'use strict';
/**
 * lib/emailTemplates.js — HTML email template builders.
 * Each function returns { subject, html, text } ready for sendEmail().
 */

function weeklyNudgeTemplate({ name, tasksCompleted, weeklySpend: _weeklySpend }) {
  const subject = `Your FocusLedger week in review`;
  const html = `<p>Hi ${name},</p><p>You completed ${tasksCompleted} tasks this week.</p>`;
  return { subject, html, text: subject };
}

function reEngagementTemplate({ name, daysSinceActive }) {
  const subject = `We miss you, ${name}`;
  const html = `<p>Hi ${name},</p><p>It's been ${daysSinceActive} days since you logged in.</p>`;
  return { subject, html, text: subject };
}

function proExpiryReminderTemplate({ name, expiresAt }) {
  const subject = `Your FocusLedger Pro subscription is expiring soon`;
  const html = `<p>Hi ${name},</p><p>Your Pro access expires on ${expiresAt}.</p>`;
  return { subject, html, text: subject };
}

module.exports = { weeklyNudgeTemplate, reEngagementTemplate, proExpiryReminderTemplate };
