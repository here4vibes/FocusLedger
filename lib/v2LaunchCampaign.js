'use strict';

// One-time V2 launch campaign — already completed; no-op on subsequent runs.
async function runV2LaunchCampaign(pool) {
  // Campaign was a one-time email blast to existing users when V2 Buddy launched.
  // The completed flag is tracked via a dedicated row in user settings;
  // this function is kept for boot-strap compatibility but does nothing now.
}

module.exports = { runV2LaunchCampaign };
