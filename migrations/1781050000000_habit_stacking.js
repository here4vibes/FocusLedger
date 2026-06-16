'use strict';
/**
 * Adds implementation-intention cue columns to buddy_daily_plans so users
 * can record "After I [cue], I will do [task]" triggers for each daily task.
 *
 * Also seeds the "Morning Essentials" routine template — a hygiene/self-care
 * anchor routine that new users get automatically and existing users are
 * offered via the Buddy session-status card.
 */

module.exports = {
  name: 'habit_stacking_cues_and_hygiene_template',

  up: async (client) => {
    // ── 1. Implementation-intention cues on buddy_daily_plans ─────────────────
    await client.query(`
      ALTER TABLE buddy_daily_plans
        ADD COLUMN IF NOT EXISTS task_1_cue TEXT,
        ADD COLUMN IF NOT EXISTS task_2_cue TEXT,
        ADD COLUMN IF NOT EXISTS task_3_cue TEXT
    `);

    // ── 2. Morning Essentials hygiene template ────────────────────────────────
    // ON CONFLICT DO NOTHING so re-running the migration is safe.
    await client.query(`
      INSERT INTO routine_templates (name, category, description, estimated_minutes, tasks)
      VALUES (
        'Morning Essentials',
        'morning',
        'The daily basics that help your brain and body start strong. Anchoring these habits to a fixed morning window reduces decision fatigue before 9 AM — especially important for ADHD brains.',
        25,
        '[
          {"title": "Drink a full glass of water",  "order": 1},
          {"title": "Take medication",              "order": 2},
          {"title": "Brush teeth",                  "order": 3},
          {"title": "Wash face or shower",          "order": 4},
          {"title": "Get dressed",                  "order": 5},
          {"title": "Eat something",                "order": 6}
        ]'::jsonb
      )
      ON CONFLICT DO NOTHING
    `);

    console.log('[migration] habit_stacking_cues_and_hygiene_template: done');
  },

  down: async (_client) => {},
};
