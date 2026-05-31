'use strict';

function taskReminderTemplate({ name, taskTitle, when }) {
  return {
    subject: `Reminder: "${taskTitle}"`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <p>Hi ${name},</p>
  <p>Just a heads-up — <strong>${taskTitle}</strong> is due <strong>${when}</strong>.</p>
  <p>Opening FocusLedger now takes 10 seconds. Future-you will be grateful.</p>
  <p style="margin-top:32px;color:#6b6b6b;font-size:13px">— FocusLedger<br><a href="https://app.focusledger.com/settings" style="color:#c9a84c">Manage email preferences</a></p>
</div>`,
  };
}

function routineStreakTemplate({ name, routineName, streak }) {
  return {
    subject: `${streak}-day streak on "${routineName}" 🔥`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <p>Hi ${name},</p>
  <p>You're on a <strong>${streak}-day streak</strong> with your <strong>${routineName}</strong> routine.</p>
  <p>That's not luck — that's a system working. Keep it going today.</p>
  <p style="margin-top:32px;color:#6b6b6b;font-size:13px">— FocusLedger<br><a href="https://app.focusledger.com/settings" style="color:#c9a84c">Manage email preferences</a></p>
</div>`,
  };
}

function weeklySummaryTemplate({ name, tasksDue, tasksCompleted }) {
  const rate = tasksDue > 0 ? Math.round((tasksCompleted / tasksDue) * 100) : 0;
  return {
    subject: `Your week in review — FocusLedger`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <p>Hi ${name},</p>
  <p>This week you had <strong>${tasksDue} tasks due</strong> and completed <strong>${tasksCompleted}</strong> — a ${rate}% completion rate.</p>
  ${tasksCompleted > 0 ? '<p>Real progress. ADHD makes this hard. You did it anyway.</p>' : '<p>A fresh week starts now. No judgment — just forward.</p>'}
  <p style="margin-top:32px;color:#6b6b6b;font-size:13px">— FocusLedger<br><a href="https://app.focusledger.com/settings" style="color:#c9a84c">Manage email preferences</a></p>
</div>`,
  };
}

function followThroughTemplate({ name, taskTitle, dueDate }) {
  return {
    subject: `Still on your list: "${taskTitle}"`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <p>Hi ${name},</p>
  <p><strong>${taskTitle}</strong> (due ${dueDate}) is still on your list.</p>
  <p>If it feels too big, let Buddy break it into 3 tiny steps. That's what the app is for.</p>
  <p style="margin-top:32px;color:#6b6b6b;font-size:13px">— FocusLedger<br><a href="https://app.focusledger.com/settings" style="color:#c9a84c">Manage email preferences</a></p>
</div>`,
  };
}

module.exports = {
  taskReminderTemplate,
  routineStreakTemplate,
  weeklySummaryTemplate,
  followThroughTemplate,
};
