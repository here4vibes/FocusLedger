'use strict';

/**
 * POST /api/capture
 * Accepts a base64-encoded image + mode ('receipt' | 'note' | 'auto').
 * Routes to GPT-4o Vision and returns structured extraction for the
 * client to confirm before saving. Does NOT write to the DB — the
 * client uses existing /api/expenses and /api/tasks endpoints to save.
 */

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { authenticateToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const captureLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many capture requests. Please wait an hour.' }
});

const VALID_CATEGORIES = [
  'groceries', 'food_delivery', 'transport', 'health', 'shopping',
  'bills', 'subscriptions', 'housing', 'fun', 'other'
];

const RECEIPT_PROMPT = `You are a receipt parser. Extract the following from this receipt image and return ONLY valid JSON.

Return this exact shape:
{
  "merchant": "store name or null",
  "amount": 12.34,
  "date": "YYYY-MM-DD or null",
  "category": "one of: groceries, food_delivery, transport, health, shopping, bills, subscriptions, housing, fun, other",
  "items": ["item1", "item2"],
  "notes": "any relevant detail or null"
}

Rules:
- amount must be a number (total paid), not a string
- date must be YYYY-MM-DD format or null
- category must be exactly one of the listed options
- items is an array of purchased items (max 5, empty array if unclear)
- If you cannot read something clearly, use null`;

const NOTE_PROMPT = `You are a task extractor. Parse this handwritten note image and extract actionable tasks.

Return ONLY valid JSON in this exact shape:
{
  "tasks": [
    {
      "title": "concise action-oriented task title",
      "due_date": "YYYY-MM-DD or null",
      "notes": "any context from the note or null"
    }
  ],
  "raw_text": "your best transcription of the handwritten text"
}

Rules:
- Each task must start with a verb (Call, Buy, Email, Schedule, etc.)
- Title max 100 characters
- due_date must be YYYY-MM-DD or null — infer from relative dates like "tomorrow", "Friday", "June 10"
- Today's date for reference: ${new Date().toISOString().slice(0, 10)}
- If text is not task-like, still extract what you can
- raw_text is your full transcription of everything visible`;

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function detectMode(base64Image, hint) {
  // Client can hint; 'auto' falls back to 'note' (receipts usually explicit)
  if (hint === 'receipt') return 'receipt';
  if (hint === 'note') return 'note';
  return 'note';
}

module.exports = function() {
  router.use(authenticateToken);
  router.use(captureLimiter);

  router.post('/', async (req, res) => {
    try {
      const { image, mode = 'auto', mimeType = 'image/jpeg' } = req.body;

      if (!image) {
        return res.status(400).json({ success: false, message: 'image is required (base64)' });
      }

      // Validate base64 size — reject if > 5MB decoded (~6.7MB base64)
      if (image.length > 7_000_000) {
        return res.status(400).json({ success: false, message: 'Image too large. Please use a photo under 5MB.' });
      }

      const resolvedMode = detectMode(image, mode);
      const prompt = resolvedMode === 'receipt' ? RECEIPT_PROMPT : NOTE_PROMPT;

      const client = getClient();
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${image}`,
                detail: 'high'
              }
            }
          ]
        }],
        response_format: { type: 'json_object' }
      });

      const raw = response.choices[0].message.content;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return res.status(422).json({ success: false, message: 'Could not read the image clearly. Try better lighting or a closer shot.' });
      }

      if (resolvedMode === 'receipt') {
        // Normalise and validate
        const amount = parseFloat(parsed.amount);
        const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
        return res.json({
          success: true,
          type: 'receipt',
          data: {
            merchant:  parsed.merchant  || null,
            amount:    isNaN(amount) ? null : Math.round(amount * 100) / 100,
            date:      parsed.date      || new Date().toISOString().slice(0, 10),
            category,
            items:     Array.isArray(parsed.items) ? parsed.items.slice(0, 5) : [],
            notes:     parsed.notes     || null
          }
        });
      } else {
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 10).map(t => ({
          title:    (t.title || '').slice(0, 100).trim(),
          due_date: t.due_date || null,
          notes:    t.notes    || null
        })).filter(t => t.title) : [];

        return res.json({
          success: true,
          type: 'note',
          data: {
            tasks,
            raw_text: parsed.raw_text || null
          }
        });
      }
    } catch (err) {
      console.error('[capture] error:', err.message);
      if (err.status === 400 && err.message?.includes('image')) {
        return res.status(422).json({ success: false, message: 'Could not process the image. Try better lighting or a closer shot.' });
      }
      res.status(500).json({ success: false, message: 'Failed to process image. Please try again.' });
    }
  });

  return router;
};
