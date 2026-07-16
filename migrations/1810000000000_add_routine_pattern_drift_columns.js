'use strict';
/**
 * Reconcile genuinely-missing columns the code referenced but prod lacked
 * (found by the schema audit). Unlike the other drift bugs — which were the
 * code using the wrong existing column name — these have no prod equivalent,
 * so they're added additively. Restores routine nudges + pattern suggestions.
 */
module.exports = {
  name: 'add_routine_pattern_drift_columns',
  up: async (client) => {
    // routine_nudge_events: the nudge copy shown to the user.
    await client.query(`ALTER TABLE routine_nudge_events ADD COLUMN IF NOT EXISTS message TEXT`);

    // routine_suggestions: message (inserted by patternDetectionJob) +
    // confidence_level / task_titles (read by patternDetection).
    await client.query(`ALTER TABLE routine_suggestions ADD COLUMN IF NOT EXISTS message          TEXT`);
    await client.query(`ALTER TABLE routine_suggestions ADD COLUMN IF NOT EXISTS confidence_level TEXT`);
    await client.query(`ALTER TABLE routine_suggestions ADD COLUMN IF NOT EXISTS task_titles      JSONB`);
  },
};
