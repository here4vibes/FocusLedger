'use strict';
/**
 * Admin access check — same rule as routes/admin.js: a user is admin if
 * users.is_admin is true OR their email is in ADMIN_EMAILS (comma-separated,
 * case-insensitive). Always judged from the DB row, never from JWT claims.
 */
const { getUserAdminInfo } = require('../db/users');

function isAdminUser(user) {
  if (!user) return false;
  if (user.is_admin === true) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return !!user.email && adminEmails.includes(user.email.toLowerCase());
}

/**
 * Express middleware: 403 unless req.user (set by an auth middleware that ran
 * first) is an admin. Fails closed: a DB error is a 500, never a pass.
 * Sets req.admin = { id, email } for the handler.
 */
function requireAdmin(pool) {
  return async function requireAdminMiddleware(req, res, next) {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
    try {
      const user = await getUserAdminInfo(pool, userId);
      if (!isAdminUser(user)) {
        console.warn('[admin-access] non-admin denied:', req.method, req.originalUrl, '| user:', userId);
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }
      req.admin = { id: userId, email: user.email }; // for audit log lines
      next();
    } catch (err) {
      console.error('[admin-access] admin lookup failed:', err.message, '| user:', userId);
      res.status(500).json({ success: false, message: 'Could not verify admin access' });
    }
  };
}

module.exports = { isAdminUser, requireAdmin };
