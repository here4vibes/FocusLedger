'use strict';
/**
 * routes/waitlist.js — iOS waitlist email capture endpoint.
 *
 * Owns: POST /api/waitlist — accepts { email, source }, stores in ios_waitlist.
 * Does NOT own: email delivery, auth (endpoint is public), duplicate checking (db layer handles it).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { addToWaitlist } = require('../db/waitlist');

// 5 signups per IP per hour — blocks simple spam without inconveniencing real users
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' }
});

module.exports = function(pool) {
  const router = express.Router();

  // POST /api/waitlist — capture email for iOS early-access list
  router.post('/', waitlistLimiter, async (req, res) => {
    try {
      const { email, source } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ success: false, message: 'Email is required.' });
      }

      // Basic email format check
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
      }

      const result = await addToWaitlist(pool, email, source || 'ios_waitlist');

      if (result.alreadyExists) {
        // Friendly — don't reveal whether they were already on the list for privacy,
        // but also don't confuse them with an error.
        return res.json({ success: true, alreadyRegistered: true });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[waitlist] POST /api/waitlist error:', err.message);
      return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
  });

  return router;
};
