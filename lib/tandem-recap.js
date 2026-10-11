'use strict';
/**
 * Tandem weekly recap: "Your week together", Monday 8am local, to each partner
 * in an active partnership.
 *
 * Accountability partners stay engaged when they see shared progress; the
 * email also brings both people back into the app. Tone rules (shame-free):
 *   - one COMBINED count of finished tasks, never "you vs them"
 *   - only shared/household task titles (already visible to the partner);
 *     personal task titles and partner concerns never appear
 *   - a quiet week sends nothing, so nobody is told they did nothing
 * Marketing-class email: opt-out footer, suppression, weekly_nudge preference.
 */
const { sendEmail } = require('./emailService');
const { getLocalDateParts } = require('./timezone');
const { _layout: L } = require('./emailTemplates');
const db = require('../db/tandem-recap');

const TEMPLATE = 'tandem_recap';
const SEND_HOUR = 8;
const MAX_TITLES = 5;

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** @returns {{subject, html, text}|null} null when there's nothing to celebrate */
function tandemRecapTemplate({ name, partnerName, together, sharedWins }) {
  if (!together && !sharedWins.length) return null;
  const partner = firstName(partnerName) || 'your partner';
  const subject = together > 0
    ? `You and ${partner} finished ${plural(together, 'thing')} this week`
    : `Your week with ${partner}`;
  const wins = sharedWins.slice(0, MAX_TITLES);
  const winsHtml = wins.length
    ? `<p style="margin:0 0 8px;">Shared wins:</p><ul style="margin:0 0 14px;padding-left:20px;">${wins.map(w => `<li>${L.esc(w)}</li>`).join('')}</ul>`
    : '';
  const html = L.shell(`
    <p style="margin:0 0 14px;">Hi ${L.esc(firstName(name) || 'there')},</p>
    <p style="margin:0 0 14px;">Together, you and ${L.esc(partner)} finished <strong>${plural(together, 'task')}</strong> this week. Every one of them counts.</p>
    ${winsHtml}
    ${L.button(`${L.APP_URL}/partner-dashboard`, 'See your week together')}`, L.marketingFooter());
  const text = `Hi ${firstName(name) || 'there'},\n\nTogether, you and ${partner} finished ${plural(together, 'task')} this week.`
    + (wins.length ? `\n\nShared wins:\n${wins.map(w => `- ${w}`).join('\n')}` : '')
    + `\n\nSee your week together: ${L.APP_URL}/partner-dashboard`;
  return { subject, html, text };
}

/**
 * Hourly (email-crons): send to each partner whose local time is Monday 8am,
 * once per local day.
 * @returns {Promise<{sent:number, skipped:number}>}
 */
async function sendTandemRecaps(pool, now = new Date()) {
  let sent = 0;
  let skipped = 0;
  const pairs = await db.getActivePartnerPairs(pool);
  for (const pair of pairs) {
    for (const [me, them] of [[pair.a, pair.b], [pair.b, pair.a]]) {
      const tz = me.timezone || 'America/New_York';
      const { date: localDate, hour, weekday } = getLocalDateParts(tz, now);
      if (weekday !== 'Mon' || hour !== SEND_HOUR) continue;
      if (me.is_qa_user || me.opted_out) { skipped++; continue; }
      if (await db.wasSentOnLocalDate(pool, me.id, TEMPLATE, tz, localDate)) continue;

      const stats = await db.getWeekTogether(pool, me.id, them.id);
      const email = tandemRecapTemplate({
        name: me.name, partnerName: them.name,
        together: stats.together, sharedWins: stats.sharedWins,
      });
      if (!email) { skipped++; continue; }

      const r = await sendEmail(pool, { to: me.email, ...email, templateType: TEMPLATE, userId: me.id });
      if (r.success) sent++;
      else if (!r.suppressed) console.error('[tandem-recap] send failed | user:', me.id, '|', r.error);
    }
  }
  if (sent) console.log(`[tandem-recap] sent ${sent} recap(s)`);
  return { sent, skipped };
}

module.exports = { tandemRecapTemplate, sendTandemRecaps, TEMPLATE };
