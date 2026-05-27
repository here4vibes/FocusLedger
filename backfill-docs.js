// Backfill: fix double-encoded JSON in metadata_json and update name from document_type.
// Run once: node backfill-docs.js
// Idempotent: skips documents that already have clean metadata.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function backfill() {
  const result = await pool.query(`
    SELECT id, name, metadata_json
    FROM documents
    WHERE ai_extracted = true
  `);

  let updated = 0;
  let skipped = 0;

  for (const row of result.rows) {
    try {
      let meta = row.metadata_json;

      // Already a proper object — check if it has nested JSON in summary field
      if (typeof meta === 'object' && meta !== null) {
        // Check if summary field contains double-encoded JSON
        if (typeof meta.summary === 'string' && meta.summary.startsWith('```json')) {
          const inner = meta.summary.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          try {
            const parsed = JSON.parse(inner);
            const newName = parsed.document_type || row.name;
            const cleanedMeta = { ...meta };
            cleanedMeta.summary = parsed.summary || parsed._plain_summary || meta.summary;
            cleanedMeta.document_type = parsed.document_type || meta.document_type;
            cleanedMeta.issuer = parsed.issuer || meta.issuer;
            cleanedMeta.policy_number = parsed.policy_number || meta.policy_number;
            cleanedMeta.expiry_date = parsed.expiry_date || meta.expiry_date;
            cleanedMeta.effective_date = parsed.effective_date || meta.effective_date;
            cleanedMeta.coverage_type = parsed.coverage_type || meta.coverage_type;
            cleanedMeta.key_terms = parsed.key_terms || meta.key_terms;
            cleanedMeta.named_parties = parsed.named_parties || meta.named_parties;
            cleanedMeta.coverage_amounts = parsed.coverage_amounts || meta.coverage_amounts;
            // Remove any remaining markdown artifacts
            delete cleanedMeta._card_title;
            delete cleanedMeta._plain_summary;

            await pool.query(`
              UPDATE documents
              SET name = $1, metadata_json = $2
              WHERE id = $3
            `, [newName, JSON.stringify(cleanedMeta), row.id]);
            updated++;
            console.log(`  [${row.id}] Updated name="${newName}", cleaned summary`);
          } catch (e) {
            console.log(`  [${row.id}] Could not parse inner JSON: ${e.message}`);
            skipped++;
          }
        } else {
          // metadata is clean object, check if name needs updating from document_type
          if (meta.document_type && row.name.startsWith('Sean-') || row.name.startsWith('2fa70') || row.name === 'Proof_of_Insurance' || row.name === 'PGRInsuranceIDCardAuto') {
            await pool.query(`
              UPDATE documents
              SET name = $1
              WHERE id = $2
            `, [meta.document_type, row.id]);
            console.log(`  [${row.id}] Updated name from document_type: "${meta.document_type}"`);
            updated++;
          } else {
            skipped++;
          }
        }
      } else {
        // metadata_json is a string — parse it
        if (typeof meta === 'string' && meta.trim().startsWith('```json')) {
          const inner = meta.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
          const parsed = JSON.parse(inner);
          const newName = parsed.document_type || row.name;
          const cleanedMeta = {
            document_type: parsed.document_type,
            issuer: parsed.issuer,
            policy_number: parsed.policy_number,
            expiry_date: parsed.expiry_date,
            effective_date: parsed.effective_date,
            coverage_type: parsed.coverage_type,
            summary: parsed.summary || parsed._plain_summary || '',
            key_terms: parsed.key_terms || [],
            named_parties: parsed.named_parties || [],
            coverage_amounts: parsed.coverage_amounts || {},
          };

          await pool.query(`
            UPDATE documents
            SET name = $1, metadata_json = $2
            WHERE id = $3
          `, [newName, JSON.stringify(cleanedMeta), row.id]);
          updated++;
          console.log(`  [${row.id}] String-backfilled: name="${newName}"`);
        } else {
          skipped++;
        }
      }
    } catch (e) {
      console.error(`  [${row.id}] Error: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  await pool.end();
}

backfill().catch(e => { console.error(e); process.exit(1); });