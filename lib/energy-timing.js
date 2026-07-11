'use strict';
/**
 * Energy-based nudge timing.
 *
 * The morning "what's on tap for today?" planning nudge is only useful when it
 * lands near the user's activation window. For someone whose peak energy is the
 * evening, an 8am plan-the-day prompt is noise they learn to ignore — the exact
 * failure mode (notification blindness) that kills retention for ADHD users.
 *
 * adhd_profile.peak_energy is a coarse 'morning' | 'afternoon' | 'evening' label
 * (AI-inferred at onboarding, stored in the users.adhd_profile JSONB). We map it
 * to a sensible send-hour for the morning planning nudge.
 *
 * This only overrides the hour when the user is still on the DEFAULT hour — if
 * they've explicitly set a morning-nudge hour, that always wins.
 */

const DEFAULT_MORNING_HOUR = 8;

// Suggested send-hour for the morning planning nudge, by peak-energy window.
const ENERGY_MORNING_HOUR = {
  morning: 8,    // sharp early — plan first thing
  afternoon: 11, // ramps late-morning — plan as they come online
  evening: 15,   // doesn't engage until later — a dawn prompt is wasted
};

/**
 * Map a peak-energy label to the suggested morning-nudge hour.
 * @param {string|null|undefined} peakEnergy
 * @returns {number} hour 0-23
 */
function energyToMorningHour(peakEnergy) {
  if (!peakEnergy) return DEFAULT_MORNING_HOUR;
  const hour = ENERGY_MORNING_HOUR[String(peakEnergy).toLowerCase()];
  return typeof hour === 'number' ? hour : DEFAULT_MORNING_HOUR;
}

/**
 * Resolve the effective morning-nudge hour.
 * NULL-means-default semantics: any numeric notif_morning_hour is an explicit
 * user choice and always wins — including an explicit 8. Only a NULL column
 * (user never set it) lets the peak-energy window decide. Callers must pass
 * the RAW column value, not a COALESCEd default, or an explicit 8am becomes
 * indistinguishable from "never chose".
 *
 * @param {number|null|undefined} configuredHour — users.notif_morning_hour (raw)
 * @param {string|null|undefined} peakEnergy — adhd_profile.peak_energy
 * @returns {number} hour 0-23
 */
function resolveMorningHour(configuredHour, peakEnergy) {
  if (typeof configuredHour === 'number' && Number.isFinite(configuredHour)) {
    return configuredHour;
  }
  return energyToMorningHour(peakEnergy);
}

module.exports = {
  DEFAULT_MORNING_HOUR,
  ENERGY_MORNING_HOUR,
  energyToMorningHour,
  resolveMorningHour,
};
