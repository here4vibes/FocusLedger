'use strict';
/**
 * agent_actions — the ledger for Cowork Stage 1 ("Buddy does it").
 * See docs/cowork-stage1-spec.md.
 *
 * Every action Buddy proposes/executes/undoes on the user's behalf is a row
 * here: the tool params, the result, and an undo_token so the action can be
 * reversed. This is the audit trail + reversibility that agentic execution
 * needs — "no silent failures" applied to actions, not just errors.
 *
 * Idempotent (CREATE ... IF NOT EXISTS) so it's the reproducible source of
 * this table on fresh DBs and prod alike.
 */
module.exports = {
  name: 'create_agent_actions',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_actions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action_type  TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','confirmed','executed','failed','undone','cancelled')),
        risk_tier    TEXT    NOT NULL CHECK (risk_tier IN ('auto','confirm')),
        params       JSONB   NOT NULL DEFAULT '{}'::jsonb,
        result       JSONB,
        undo_token   JSONB,
        error        TEXT,
        source       TEXT    NOT NULL DEFAULT 'weightless',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        executed_at  TIMESTAMPTZ,
        undone_at    TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS agent_actions_user_created_idx ON agent_actions (user_id, created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS agent_actions_status_idx ON agent_actions (status)`
    );
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS agent_actions`);
  },
};
