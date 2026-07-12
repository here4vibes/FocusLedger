'use strict';
// Owns: Daily Reveal read + viewed tracking.
// Does NOT own: reveal generation (jobs/dailyRevealJob.js), insights, nudges.
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getRevealForDate, markRevealViewed } = require('../db/reveals');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

// science_tag → science-page anchor + human label, rendered as the
// "why this works" footer under an opened reveal.
const SCIENCE_LABELS = {
  avoidance_loops:    'Avoidance loops & task initiation',
  salutogenesis:      'From deficit to coherence',
  cross_domain:       'Cross-domain intelligence',
  accountability:     'Accountability & social commitment',
  executive_function: 'Executive function & working memory',
  impulse_spending:   'ADHD & impulsive spending',
  habit_formation:    'Behavioral nudges & habit formation',
};

module.exports = function (pool) {
  const router = express.Router();

  // GET /api/reveals/today — today's reveal (user-local date), sealed or opened.
  router.get('/today', authenticateToken, async (req, res) => {
    try {
      const tz = await fetchUserTimezone(pool, req.user.id);
      const localDate = getUserLocalDate(tz);
      const reveal = await getRevealForDate(pool, req.user.id, localDate);
      if (!reveal) return res.json({ success: true, reveal: null });

      res.json({
        success: true,
        reveal: {
          id: reveal.id,
          headline: reveal.headline,
          body: reveal.body,
          reveal_type: reveal.reveal_type,
          science_tag: reveal.science_tag,
          science_label: SCIENCE_LABELS[reveal.science_tag] || null,
          source_label: reveal.source_label || null,
          source_url: reveal.source_url || null,
          viewed: !!reveal.viewed_at,
        },
      });
    } catch (err) {
      console.error('[reveals] GET /today failed:', err.message, '| userId:', req.user?.id);
      res.status(500).json({ success: false, message: 'Failed to fetch reveal' });
    }
  });

  // POST /api/reveals/:id/viewed — the unwrap moment; first view wins.
  router.post('/:id/viewed', authenticateToken, async (req, res) => {
    try {
      const revealId = parseInt(req.params.id, 10);
      if (!Number.isInteger(revealId)) {
        return res.status(400).json({ success: false, message: 'Invalid reveal id' });
      }
      const updated = await markRevealViewed(pool, req.user.id, revealId);
      if (!updated) return res.status(404).json({ success: false, message: 'Reveal not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('[reveals] POST /:id/viewed failed:', err.message, '| userId:', req.user?.id);
      res.status(500).json({ success: false, message: 'Failed to mark viewed' });
    }
  });

  return router;
};
