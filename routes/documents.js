// Owns: document vault endpoints — upload, list, view, delete, AI extraction, metadata review.
// Does NOT own: user auth, file storage credentials, or subscription gating logic.
//
// Endpoints:
//   GET    /api/documents                        — list user's documents (search/filter)
//   POST   /api/documents/upload                 — upload to R2, fire async AI extraction
//   GET    /api/documents/usage/ai               — remaining AI extractions this month
//   GET    /api/documents/:id                    — get single document metadata
//   GET    /api/documents/:id/extraction-status  — poll async extraction state
//   PATCH  /api/documents/:id                    — update metadata (name, notes, expiry, etc.)
//   PATCH  /api/documents/:id/confirm-metadata   — user confirms/overrides extracted metadata
//   DELETE /api/documents/:id                    — delete document (R2 + DB)

const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
const { extractDocumentMetadata } = require('../lib/documentExtraction');

const FREE_DOC_LIMIT = 20;
const AI_EXTRACTION_MONTHLY_LIMIT = 25;

// Multer: in-memory, 10MB cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, PNG, JPG, and HEIC files are accepted.'));
    }
  }
});


module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── GET /api/documents ───────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { category, q } = req.query;

      let sql = `
        SELECT id, name, category, s3_url, file_size, mime_type,
               uploaded_at, expiry_date, metadata_json, notes, ai_extracted,
               extraction_status, extraction_confidence, metadata_confirmed
        FROM documents
        WHERE user_id = $1
      `;
      const params = [userId];

      if (category && category !== 'All') {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }

      if (q) {
        params.push(`%${q}%`);
        sql += ` AND (name ILIKE $${params.length} OR notes ILIKE $${params.length} OR metadata_json::text ILIKE $${params.length})`;
      }

      sql += ' ORDER BY uploaded_at DESC';

      const result = await pool.query(sql, params);
      res.json({ success: true, documents: result.rows });
    } catch (err) {
      console.error('[documents] list error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load documents.' });
    }
  });

  // ─── GET /api/documents/usage/ai ─────────────────────────────────────────
  router.get('/usage/ai', async (req, res) => {
    try {
      const userId = req.user.id;
      const month = getCurrentMonth();
      const result = await pool.query(
        'SELECT extraction_count FROM ai_extraction_usage WHERE user_id = $1 AND month = $2',
        [userId, month]
      );
      const used = result.rows[0]?.extraction_count || 0;
      res.json({
        success: true,
        used,
        limit: AI_EXTRACTION_MONTHLY_LIMIT,
        remaining: Math.max(0, AI_EXTRACTION_MONTHLY_LIMIT - used)
      });
    } catch (err) {
      console.error('[documents] ai usage error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch usage.' });
    }
  });

  // ─── POST /api/documents/upload ───────────────────────────────────────────
  // Returns immediately after R2 upload. AI extraction fires in background.
  router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    const userId = req.user.id;
    const { name, category, notes, expiry_date } = req.body;

    try {
      // Free tier: check doc count limit
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      if (!isPro) {
        const countResult = await pool.query(
          'SELECT COUNT(*) FROM documents WHERE user_id = $1',
          [userId]
        );
        const count = parseInt(countResult.rows[0].count, 10);
        if (count >= FREE_DOC_LIMIT) {
          return res.status(403).json({
            success: false,
            message: `Free accounts can store up to ${FREE_DOC_LIMIT} documents. Upgrade to Pro for unlimited storage.`,
            code: 'DOC_LIMIT_REACHED'
          });
        }
      }

      // Upload file to R2 via Polsia proxy
      const formData = new FormData();
      formData.append('file', req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });

      const r2Res = await fetch('https://polsia.com/api/proxy/r2/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      const r2Data = await r2Res.json();
      if (!r2Data.success) {
        console.error('[documents] R2 upload failed:', r2Data);
        return res.status(502).json({ success: false, message: 'File storage failed. Try again.' });
      }

      const s3Url = r2Data.file.url;

      // Check if AI extraction quota is available
      const month = getCurrentMonth();
      const usageResult = await pool.query(
        'SELECT extraction_count FROM ai_extraction_usage WHERE user_id = $1 AND month = $2',
        [userId, month]
      );
      const usedThisMonth = usageResult.rows[0]?.extraction_count || 0;
      const aiQuotaAvailable = usedThisMonth < AI_EXTRACTION_MONTHLY_LIMIT && req.body.ai_extract !== 'false';

      // Persist to DB immediately — extraction_status reflects async state
      const docResult = await pool.query(`
        INSERT INTO documents
          (user_id, name, category, s3_url, file_size, mime_type,
           expiry_date, metadata_json, notes, ai_extracted, extraction_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, name, category, s3_url, file_size, mime_type,
                  uploaded_at, expiry_date, metadata_json, notes, ai_extracted,
                  extraction_status, extraction_confidence, metadata_confirmed
      `, [
        userId,
        name || req.file.originalname,
        category || 'Other',
        s3Url,
        req.file.size,
        req.file.mimetype,
        expiry_date || null,
        JSON.stringify({}),
        notes || null,
        false,
        aiQuotaAvailable ? 'pending' : 'none'
      ]);

      const doc = docResult.rows[0];

      // Respond immediately — extraction is fire-and-forget
      res.json({
        success: true,
        document: doc,
        ai_queued: aiQuotaAvailable,
        ai_remaining: Math.max(0, AI_EXTRACTION_MONTHLY_LIMIT - usedThisMonth)
      });

      // Fire extraction in background if quota available
      if (aiQuotaAvailable) {
        // Mark processing before we start (best-effort update)
        pool.query(
          "UPDATE documents SET extraction_status = 'processing' WHERE id = $1",
          [doc.id]
        ).catch(() => {});

        runExtractionAsync(pool, doc.id, s3Url, req.file.mimetype, doc.name, userId, month);
      }

    } catch (err) {
      console.error('[documents] upload error:', err.message);
      res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
    }
  });

  // ─── GET /api/documents/:id/extraction-status ────────────────────────────
  // Frontend polls this until status is 'done' or 'failed'.
  router.get('/:id/extraction-status', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, extraction_status, ai_extracted, metadata_json,
                extraction_confidence, metadata_confirmed, expiry_date
         FROM documents WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }
      res.json({ success: true, ...result.rows[0] });
    } catch (err) {
      console.error('[documents] extraction-status error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch status.' });
    }
  });

  // ─── GET /api/documents/:id ───────────────────────────────────────────────
  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT *, extraction_status, extraction_confidence, metadata_confirmed
         FROM documents WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }
      res.json({ success: true, document: result.rows[0] });
    } catch (err) {
      console.error('[documents] get error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load document.' });
    }
  });

  // ─── PATCH /api/documents/:id/confirm-metadata ───────────────────────────
  // User reviews AI-extracted metadata and confirms (optionally editing fields).
  // After confirmation, expiry_date/category on the document row may be updated
  // if the user accepted AI-suggested values.
  router.patch('/:id/confirm-metadata', async (req, res) => {
    try {
      const { metadata_json, expiry_date, category } = req.body;

      const result = await pool.query(`
        UPDATE documents
        SET metadata_json = COALESCE($1::jsonb, metadata_json),
            expiry_date   = COALESCE($2, expiry_date),
            category      = COALESCE($3, category),
            metadata_confirmed = true
        WHERE id = $4 AND user_id = $5
        RETURNING id, name, category, s3_url, file_size, mime_type,
                  uploaded_at, expiry_date, metadata_json, notes, ai_extracted,
                  extraction_status, extraction_confidence, metadata_confirmed
      `, [
        metadata_json ? JSON.stringify(metadata_json) : null,
        expiry_date || null,
        category || null,
        req.params.id,
        req.user.id
      ]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }
      res.json({ success: true, document: result.rows[0] });
    } catch (err) {
      console.error('[documents] confirm-metadata error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to confirm metadata.' });
    }
  });

  // ─── PATCH /api/documents/:id ─────────────────────────────────────────────
  router.patch('/:id', async (req, res) => {
    try {
      const { name, category, notes, expiry_date, metadata_json } = req.body;
      const result = await pool.query(`
        UPDATE documents
        SET name = COALESCE($1, name),
            category = COALESCE($2, category),
            notes = COALESCE($3, notes),
            expiry_date = $4,
            metadata_json = COALESCE($5::jsonb, metadata_json)
        WHERE id = $6 AND user_id = $7
        RETURNING id, name, category, s3_url, file_size, mime_type,
                  uploaded_at, expiry_date, metadata_json, notes, ai_extracted,
                  extraction_status, extraction_confidence, metadata_confirmed
      `, [
        name || null,
        category || null,
        notes || null,
        expiry_date || null,
        metadata_json ? JSON.stringify(metadata_json) : null,
        req.params.id,
        req.user.id
      ]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }
      res.json({ success: true, document: result.rows[0] });
    } catch (err) {
      console.error('[documents] patch error:', err.message);
      res.status(500).json({ success: false, message: 'Update failed.' });
    }
  });

  // ─── DELETE /api/documents/:id ────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING s3_url',
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Document not found.' });
      }

      // Best-effort: delete from R2. Non-fatal if it fails.
      const fileKey = extractR2Key(result.rows[0].s3_url);
      if (fileKey) {
        fetch(`https://polsia.com/api/proxy/r2/files/${encodeURIComponent(fileKey)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` },
        }).catch(err => console.error('[documents] R2 delete failed:', err.message));
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[documents] delete error:', err.message);
      res.status(500).json({ success: false, message: 'Delete failed.' });
    }
  });

  return router;
};

// ─── Async extraction runner ──────────────────────────────────────────────────
// Runs outside request lifecycle. Updates document row when done.
async function runExtractionAsync(pool, docId, fileUrl, mimeType, fileName, userId, month) {
  try {
    const { metadata, confidence } = await extractDocumentMetadata(fileUrl, mimeType, fileName);

    // Increment monthly counter (upsert)
    await pool.query(`
      INSERT INTO ai_extraction_usage (user_id, month, extraction_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (user_id, month) DO UPDATE
        SET extraction_count = ai_extraction_usage.extraction_count + 1
    `, [userId, month]);

    // Pull extracted title and plain summary — strip underscore-prefixed fields
    // from what we store in metadata_json so we keep only the real document fields.
    const extractedName = metadata._card_title || null;
    // Prefer _plain_summary (explicit plain-text field) over summary (may be JSON from confused model).
    // Write the clean text back to summary so all rendering paths read one field.
    const summaryText = metadata._plain_summary || metadata.summary || null;
    delete metadata._card_title;
    delete metadata._plain_summary;
    // Always write clean plain-text summary — prevents raw JSON from leaking into the card.
    if (summaryText) metadata.summary = summaryText;

    // Build the update — populate name from AI title, expiry_date from extraction,
    // and drop underscore-prefixed fields from stored metadata.
    const sql = `
      UPDATE documents
      SET name                = COALESCE($1, name),
          metadata_json       = $2::jsonb,
          extraction_confidence = $3::jsonb,
          ai_extracted       = true,
          extraction_status  = 'done',
          expiry_date        = COALESCE(expiry_date, $5::date),
          metadata_confirmed = false
      WHERE id = $4
    `;
    await pool.query(sql, [
      extractedName,
      JSON.stringify(metadata),
      JSON.stringify(confidence),
      docId,
      metadata.expiry_date || null
    ]);

    console.log(`[documents] extraction done for doc ${docId}: name="${extractedName || '(unchanged)'}"`);
  } catch (err) {
    console.error(`[documents] async extraction failed for doc ${docId}:`, err.message);
    pool.query(
      "UPDATE documents SET extraction_status = 'failed' WHERE id = $1",
      [docId]
    ).catch(() => {});
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function extractR2Key(url) {
  try {
    const u = new URL(url);
    return u.pathname.slice(1);
  } catch {
    return null;
  }
}

