'use strict';
/**
 * routes/account-deletion.js
 * Owns: user account deletion — admin hard-delete and user self-service deletion with email confirmation.
 * Does NOT own: authentication middleware (middleware/auth.js), email sending (lib/emailService.js),
 *              database queries (db/account-deletion.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { accountDeletionTemplate } = require('../lib/emailTemplates');
const {
  createDeletionToken,
  findValidToken,
  markTokenUsed,
  deleteUserCascade,
  getUserById,
  getUserAdminInfo,
  cancelActiveSubscription
} = require('../db/account-deletion');

// Admin gate helper — mirrors pattern from routes/admin.js
function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

module.exports = function(pool) {
  const router = express.Router();

  // =========================================================================
  // ADMIN: DELETE /api/account-deletion/admin/:id
  // Hard-deletes a user and all their data. No email confirmation — admin is trusted.
  // =========================================================================
  router.delete('/admin/:id', authenticateToken, async (req, res) => {
    try {
      const adminId = req.user.id;
      const targetId = parseInt(req.params.id, 10);

      if (isNaN(targetId)) {
        return res.status(400).json({ success: false, message: 'Invalid user ID' });
      }

      // Admin gate
      const admin = await getUserAdminInfo(pool, adminId);
      if (!admin || !isAdminUser(admin)) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Prevent admin deleting themselves
      if (targetId === adminId) {
        return res.status(400).json({ success: false, message: 'Cannot delete your own account via admin panel' });
      }

      // Verify target exists
      const target = await getUserById(pool, targetId);
      if (!target) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      console.log(`[account-deletion] Admin ${admin.email} deleting user ${target.email} (id=${targetId})`);

      await cancelActiveSubscription(pool, targetId);
      await deleteUserCascade(pool, targetId);

      res.json({
        success: true,
        message: `User ${target.email} and all their data have been permanently deleted.`,
        deleted_email: target.email
      });
    } catch (err) {
      console.error('[account-deletion] Admin delete error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
  });

  // =========================================================================
  // USER SELF-SERVICE: POST /api/account-deletion/request
  // Sends confirmation email with a one-time deletion token.
  // =========================================================================
  router.post('/request', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const user = await getUserById(pool, userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Create token (invalidates any prior unused tokens for this user)
      const { raw } = await createDeletionToken(pool, userId);

      const APP_URL = process.env.APP_URL || 'https://focusledger.net';
      const confirmUrl = `${APP_URL}/confirm-delete?token=${raw}`;

      const { subject, html } = accountDeletionTemplate({ confirmUrl });

      const emailResult = await sendEmail(pool, {
        to: user.email,
        subject,
        html,
        templateType: 'account_deletion_confirm',
        userId
      });

      if (!emailResult.success) {
        console.error(`[account-deletion] Failed to send confirmation email to ${user.email}`);
        return res.status(500).json({
          success: false,
          message: 'Failed to send confirmation email. Please try again.'
        });
      }

      console.log(`[account-deletion] Confirmation email sent to ${user.email} (id=${userId})`);

      res.json({
        success: true,
        message: `A confirmation email has been sent to ${user.email}. Click the link in the email to complete deletion. The link expires in 24 hours.`
      });
    } catch (err) {
      console.error('[account-deletion] Request error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to initiate account deletion' });
    }
  });

  // =========================================================================
  // USER SELF-SERVICE: POST /api/account-deletion/confirm
  // Validates the token and executes cascade deletion.
  // No auth header required — the token IS the credential.
  // =========================================================================
  router.post('/confirm', async (req, res) => {
    try {
      const { token } = req.body;

      if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, message: 'Token is required' });
      }

      const tokenRow = await findValidToken(pool, token);
      if (!tokenRow) {
        return res.status(400).json({
          success: false,
          message: 'This link is invalid or has expired. Please request a new deletion link from Settings.'
        });
      }

      const userId = tokenRow.user_id;

      // Get email before delete (for logging)
      const user = await getUserById(pool, userId);
      const userEmail = user?.email || 'unknown';

      // Mark token used first — prevents two concurrent requests both passing findValidToken
      await markTokenUsed(pool, tokenRow.id);

      // Cancel subscription before cascade (Stripe webhook correlation)
      await cancelActiveSubscription(pool, userId);

      await deleteUserCascade(pool, userId);

      console.log(`[account-deletion] Self-service deletion complete for ${userEmail} (id=${userId})`);

      res.json({
        success: true,
        message: 'Your account has been permanently deleted. All your data has been removed.'
      });
    } catch (err) {
      console.error('[account-deletion] Confirm error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to delete account. Please contact support.' });
    }
  });

  return router;
};
