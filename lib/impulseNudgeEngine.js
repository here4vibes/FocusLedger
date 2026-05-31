'use strict';

const HIGH_IMPULSE_RATIO = 0.5;   // ≥50% impulse buys triggers alert
const MIN_IMPULSE_COUNT  = 3;     // need at least 3 impulse buys
const HIGH_SPEND_CENTS   = 50000; // $500 total spend threshold
const HIGH_SPEND_RATIO   = 0.3;   // 30% unplanned at high-spend level

/**
 * Evaluate weekly spending stats and return an alert object, or null if none warranted.
 *
 * @param {{ total_spent, impulse_count, total_count }} stats
 * @returns {{ alertType: string, message: string } | null}
 */
function buildSpendingAlert(stats) {
  if (!stats) return null;

  const totalCents  = parseInt(stats.total_spent,   10) || 0;
  const impulse     = parseInt(stats.impulse_count,  10) || 0;
  const total       = parseInt(stats.total_count,    10) || 0;

  if (total === 0) return null;
  const ratio = impulse / total;

  if (ratio >= HIGH_IMPULSE_RATIO && impulse >= MIN_IMPULSE_COUNT) {
    return {
      alertType: 'high_impulse',
      message:   `${impulse} of your last ${total} purchases were impulse buys. Want to pause before the next one?`,
    };
  }

  if (totalCents >= HIGH_SPEND_CENTS && ratio >= HIGH_SPEND_RATIO) {
    const dollars = (totalCents / 100).toFixed(0);
    return {
      alertType: 'high_spend',
      message:   `You've spent $${dollars} this week — ${Math.round(ratio * 100)}% unplanned. That's the ADHD tax at work.`,
    };
  }

  return null;
}

module.exports = { buildSpendingAlert };
