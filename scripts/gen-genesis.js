'use strict';
// Reads the prod information_schema.columns CSV → emits an idempotent genesis
// migration (CREATE TABLE IF NOT EXISTS for every table). Columns/types/defaults
// only; PK/unique/FK + indexes come from Query 2/3 (or pg_dump) in a follow-up.
const fs = require('fs');
const CSV = process.argv[2];
const rows = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);

// Minimal CSV line parser (handles quoted fields with embedded commas).
function parse(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const header = parse(rows[0]);
const idx = (n) => header.indexOf(n);
const iTable = idx('table_name'), iCol = idx('column_name'), iType = idx('data_type'),
  iLen = idx('character_maximum_length'), iPrec = idx('numeric_precision'),
  iScale = idx('numeric_scale'), iNull = idx('is_nullable'), iDef = idx('column_default');

const tables = new Map();
for (let r = 1; r < rows.length; r++) {
  const f = parse(rows[r]);
  const t = f[iTable];
  if (!tables.has(t)) tables.set(t, []);
  tables.get(t).push({
    col: f[iCol], type: f[iType], len: f[iLen], prec: f[iPrec], scale: f[iScale],
    nullable: f[iNull], def: f[iDef],
  });
}

function typeOf(c) {
  const isSeq = c.def && /^nextval\(/i.test(c.def);
  switch (c.type) {
    case 'integer': return isSeq ? 'SERIAL' : 'INTEGER';
    case 'bigint': return isSeq ? 'BIGSERIAL' : 'BIGINT';
    case 'smallint': return 'SMALLINT';
    case 'text': return 'TEXT';
    case 'character varying': return `VARCHAR(${c.len || 255})`;
    case 'numeric': return `NUMERIC(${c.prec || 12},${c.scale || 2})`;
    case 'boolean': return 'BOOLEAN';
    case 'date': return 'DATE';
    case 'timestamp with time zone': return 'TIMESTAMPTZ';
    case 'timestamp without time zone': return 'TIMESTAMP';
    case 'json': return 'JSON';
    case 'jsonb': return 'JSONB';
    case 'double precision': return 'DOUBLE PRECISION';
    default: return 'TEXT'; // USER-DEFINED/enums → TEXT (safe)
  }
}

// Explicit PKs from prod (Query 2) where the PK isn't the conventional `id`.
const PK = { session: 'sid' };
// Composite UNIQUE constraints the app relies on (Query 2 + ON CONFLICT usage).
// Baked into fresh DBs so every ON CONFLICT target exists; no-op on prod.
const UNIQUES = {
  buddy_checkins: ['user_id', 'checkin_date', 'checkin_type'],
  buddy_daily_plans: ['user_id', 'plan_date'],
  buddy_midday_checkins: ['user_id', 'checkin_date', 'checkin_type'],
  daily_reveals: ['user_id', 'reveal_date'],
  detected_patterns: ['user_id', 'pattern_type', 'task_hash'],
  one_off_email_log: ['user_id', 'campaign'],
  // orphan tables whose ON CONFLICT had no matching constraint (the drift fixes):
  nudges: ['user_id', 'notification_key'],
  linked_emails: ['user_id', 'email'],
  email_tasks_stash: ['message_id'],
  push_subscriptions: ['user_id', 'endpoint'],
};

function colDDL(c, table) {
  const isSeq = c.def && /^nextval\(/i.test(c.def);
  let type = typeOf(c);
  // Make the primary key column a SERIAL PRIMARY KEY on fresh DBs even where prod
  // (Prisma-orphaned) left it nullable & keyless — fresh DBs come out correct.
  const isPk = (PK[table] ? PK[table] === c.col : c.col === 'id');
  if (isPk) {
    if (type === 'INTEGER' || type === 'SERIAL') type = 'SERIAL';
    return `  ${c.col} ${type} PRIMARY KEY`;
  }
  let s = `  ${c.col} ${type}`;
  if (c.nullable === 'NO') s += ' NOT NULL';
  if (c.def && !isSeq) s += ` DEFAULT ${c.def}`; // sequences handled by SERIAL
  return s;
}

let out = `'use strict';
/**
 * migrations/0000000000000_genesis_baseline.js
 * AUTO-GENERATED from production information_schema (${tables.size} tables).
 * Idempotent: CREATE TABLE IF NOT EXISTS — a no-op on prod (tables already
 * exist), full schema on a fresh DB. Makes the schema reproducible from source.
 * NOTE: columns + types + defaults only. PK/unique/FK + indexes are added by a
 * follow-up migration from Query 2/3 (or pg_dump). Runs first (timestamp 0).
 */
module.exports = {
  name: 'genesis_baseline',
  up: async (client) => {
`;

for (const t of [...tables.keys()].sort()) {
  const colDefs = tables.get(t).map((c) => colDDL(c, t));
  const cols = colDefs.join(',\n');
  const uniq = UNIQUES[t] ? `,\n  UNIQUE (${UNIQUES[t].join(', ')})` : '';
  out += `    await client.query(\`CREATE TABLE IF NOT EXISTS ${t} (\n${cols}${uniq}\n    )\`);\n`;
}
out += `  },
};
`;

process.stdout.write(out);
console.error(`[gen] ${tables.size} tables, ${rows.length - 1} columns`);
