// Owns: shared AI HTTP endpoints — summarize, extract-fields.
// Does NOT own: Buddy conversation, document upload, or auth.
// Extraction delegates to lib/documentExtraction.js; summarization uses polsia-ai.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { summarizeText, suggestTaskFromText, parseAIResponse } = require('../lib/ai-service');

module.exports = function(_pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── POST /api/ai/summarize ─────────────────────────────────────────
  // Generic text summarization. Returns { success, summary }.
  // Body: { text: string, maxLength?: number }
  router.post('/summarize', async (req, res) => {
    const { text, maxLength } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, message: 'text required' });
    }

    try {
      const summary = await summarizeText(text, maxLength || 200);
      res.json({ success: true, summary });
    } catch (err) {
      console.error('[ai] /summarize error:', err.message);
      res.status(500).json({ success: false, message: 'Summarization failed' });
    }
  });

  // ─── POST /api/ai/extract-fields ────────────────────────────────────
  // Extract structured fields from a document file (by URL).
  // Body: { fileUrl: string, fileName: string, mimeType?: string }
  // Returns: { success, metadata, confidence }
  router.post('/extract-fields', async (req, res) => {
    const { fileUrl, fileName, mimeType } = req.body || {};
    if (!fileUrl || !fileName) {
      return res.status(400).json({ success: false, message: 'fileUrl and fileName required' });
    }

    try {
      const { extractDocumentMetadata } = require('../lib/documentExtraction');
      const { metadata, confidence } = await extractDocumentMetadata(fileUrl, mimeType || 'application/pdf', fileName);
      res.json({ success: true, metadata, confidence });
    } catch (err) {
      console.error('[ai] /extract-fields error:', err.message);
      res.status(500).json({ success: false, message: 'Document extraction failed' });
    }
  });

  // ─── POST /api/ai/suggest-tasks ─────────────────────────────────────
  // Parse freeform text into task suggestions (Buddy brain-dump style).
  // Body: { text: string, values?: [{id, value_name}] }
  // Returns: { success, tasks: [{ title, value_name, value_id, priority }] }
  router.post('/suggest-tasks', async (req, res) => {
    const { text, values } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, message: 'text required' });
    }

    try {
      const tasks = await suggestTaskFromText(text, values || []);
      res.json({ success: true, tasks });
    } catch (err) {
      console.error('[ai] /suggest-tasks error:', err.message);
      res.status(500).json({ success: false, message: 'Task extraction failed' });
    }
  });

  // ─── POST /api/ai/parse-ai-response ──────────────────────────────────
  // Normalize an AI raw response string/object into a consistent field map.
  // Body: { raw: string|object }
  // Returns: { success, fields }
  router.post('/parse-ai-response', (req, res) => {
    const { raw } = req.body || {};
    const fields = parseAIResponse(raw);
    res.json({ success: true, fields });
  });

  return router;
};