// routes/partnerships.js
// Owns: Tandem partnership API — invite generation, invite acceptance, status, dissolve,
//       partner task visibility + completion feed, task sharing flag updates,
//       Tandem subscription access checks, partner concern soft signals.
// Does NOT own: Buddy conversation logic, Stripe webhook processing.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  createInvite,
  findPendingInvite,
  acceptInvite,
  getActivePartnership,
  getPendingInvite,
  dissolvePartnership,
  cancelPendingInvite,
  getPartnerSharedTasks,
  updateTaskSharingFlags,
  getPartnerCompletionFeed,
  checkTandemAccess,
  activateTandemSubscription,
  activateTandemTrial,
  createPartnerConcern,
} = require('../db/partnerships');

module.exports = function (pool) {
  const router = express.Router();

  // ── GET /api/partnerships/status ─────────────────────────────────────────
  // Returns active partnership (with partner info) or pending invite, or null.
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const active = await getActivePartnership(pool, userId);
      if (active) {
        return res.json({ success: true, state: 'active', partnership: active });
      }

      const pending = await getPendingInvite(pool, userId);
      if (pending) {
        const inviteUrl = buildInviteUrl(req, pending.invite_token);
        return res.json({
          success: true,
          state: 'pending_sent',
          invite: { ...pending, invite_url: inviteUrl },
        });
      }

      return res.json({ success: true, state: 'none' });
    } catch (err) {
      console.error('[partnerships/status]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch partnership status' });
    }
  });

  // ── POST /api/partnerships/invite ────────────────────────────────────────
  // Generates a new invite link for the authenticated user.
  // Rejected if user already has an active partnership or unexpired pending invite.
  router.post('/invite', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      // Block if already active
      const active = await getActivePartnership(pool, userId);
      if (active) {
        return res.status(409).json({
          success: false,
          message: 'You already have an active accountability partner.',
        });
      }

      // Cancel any stale pending invite first (idempotent — one pending per inviter)
      await cancelPendingInvite(pool, userId);

      const invite = await createInvite(pool, userId);
      const inviteUrl = buildInviteUrl(req, invite.invite_token);

      res.json({
        success: true,
        invite: { ...invite, invite_url: inviteUrl },
      });
    } catch (err) {
      console.error('[partnerships/invite]', err.message);
      res.status(500).json({ success: false, message: 'Failed to create invite' });
    }
  });

  // ── GET /api/partnerships/invite/:token ──────────────────────────────────
  // Returns invite metadata for the accept-invite page (no auth required —
  // recipient may not have an account yet).
  router.get('/invite/:token', async (req, res) => {
    try {
      const invite = await findPendingInvite(pool, req.params.token);
      if (!invite) {
        return res.status(404).json({
          success: false,
          message: 'This invite link has expired or is no longer valid.',
        });
      }
      // Return enough info to render the accept page, without exposing sensitive data
      res.json({
        success: true,
        invite: {
          inviter_name: invite.inviter_name,
          inviter_avatar: invite.inviter_avatar,
          invite_expires_at: invite.invite_expires_at,
        },
      });
    } catch (err) {
      console.error('[partnerships/invite/:token]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch invite' });
    }
  });

  // ── POST /api/partnerships/accept ────────────────────────────────────────
  // Authenticated user accepts an invite by token.
  // Fails if invitee already has an active partnership.
  router.post('/accept', authenticateToken, async (req, res) => {
    try {
      const { token } = req.body;
      const userId = req.user.id;

      if (!token) {
        return res.status(400).json({ success: false, message: 'token is required' });
      }

      // Verify invite still valid before attempting update
      const invite = await findPendingInvite(pool, token);
      if (!invite) {
        return res.status(404).json({
          success: false,
          message: 'This invite link has expired or is no longer valid.',
        });
      }

      if (invite.inviter_id === userId) {
        return res.status(400).json({
          success: false,
          message: 'You cannot accept your own invite.',
        });
      }

      // Check invitee for existing active partnership
      const existingPartnership = await getActivePartnership(pool, userId);
      if (existingPartnership) {
        return res.status(409).json({
          success: false,
          message: 'You already have an active accountability partner.',
        });
      }

      const partnership = await acceptInvite(pool, token, userId);
      if (!partnership) {
        // Race condition: invite was claimed between our check and update
        return res.status(409).json({
          success: false,
          message: 'This invite is no longer available.',
        });
      }

      // Start the 14-day Tandem trial for both partners on the new partnership
      // Best-effort — trial activation failure doesn't block the partnership acceptance
      activateTandemTrial(pool, partnership.id).catch(err => {
        console.error('[partnerships/accept] trial activation error:', err.message);
      });

      res.json({ success: true, partnership });
    } catch (err) {
      // WHY: unique index violation = invitee already has active partner (race condition)
      if (err.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'You already have an active accountability partner.',
        });
      }
      console.error('[partnerships/accept]', err.message);
      res.status(500).json({ success: false, message: 'Failed to accept invite' });
    }
  });

  // ── DELETE /api/partnerships/:id ─────────────────────────────────────────
  // Either partner can dissolve the active partnership.
  router.delete('/:id', authenticateToken, async (req, res) => {
    try {
      const partnershipId = parseInt(req.params.id, 10);
      if (!partnershipId) {
        return res.status(400).json({ success: false, message: 'Invalid partnership id' });
      }

      const dissolved = await dissolvePartnership(pool, partnershipId, req.user.id);
      if (!dissolved) {
        return res.status(404).json({
          success: false,
          message: 'Partnership not found or already ended.',
        });
      }

      res.json({ success: true, message: 'Partnership ended.' });
    } catch (err) {
      console.error('[partnerships/dissolve]', err.message);
      res.status(500).json({ success: false, message: 'Failed to dissolve partnership' });
    }
  });

  // ── DELETE /api/partnerships/invite/cancel ────────────────────────────────
  // Cancel a pending outgoing invite before anyone accepts it.
  router.delete('/invite/cancel', authenticateToken, async (req, res) => {
    try {
      await cancelPendingInvite(pool, req.user.id);
      res.json({ success: true, message: 'Invite cancelled.' });
    } catch (err) {
      console.error('[partnerships/invite/cancel]', err.message);
      res.status(500).json({ success: false, message: 'Failed to cancel invite' });
    }
  });

  // ── GET /api/partnerships/partner-tasks ───────────────────────────────────
  // Returns partner's shared + household tasks for the dashboard.
  // Only tasks where is_household=true OR is_shared_with_partner=true are returned —
  // private tasks are never surfaced here.
  router.get('/partner-tasks', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const active = await getActivePartnership(pool, userId);
      if (!active) {
        return res.status(403).json({
          success: false,
          message: 'No active partnership.',
        });
      }

      const result = await getPartnerSharedTasks(pool, userId);
      if (!result) {
        return res.json({ success: true, tasks: [], partner: active });
      }

      res.json({ success: true, tasks: result.tasks, partner: active });
    } catch (err) {
      console.error('[partnerships/partner-tasks]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch partner tasks' });
    }
  });

  // ── GET /api/partnerships/completion-feed ─────────────────────────────────
  // Returns partner's recently completed shared tasks (last 48h).
  // Used for the "Alex completed X 2 hours ago" feed in the dashboard.
  router.get('/completion-feed', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const active = await getActivePartnership(pool, userId);
      if (!active) {
        return res.status(403).json({ success: false, message: 'No active partnership.' });
      }

      const result = await getPartnerCompletionFeed(pool, userId);
      if (!result) {
        return res.json({ success: true, completions: [], partner_name: active.partner_name });
      }

      res.json({
        success: true,
        completions: result.completions,
        partner_name: result.partner_name,
      });
    } catch (err) {
      console.error('[partnerships/completion-feed]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch completion feed' });
    }
  });

  // ── PATCH /api/partnerships/tasks/:taskId/share ───────────────────────────
  // Toggle is_shared_with_partner or is_household on one of the user's own tasks.
  // Body: { is_household?: bool, is_shared_with_partner?: bool }
  router.patch('/tasks/:taskId/share', authenticateToken, async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const userId = req.user.id;
      const { is_household, is_shared_with_partner } = req.body;

      if (!taskId) {
        return res.status(400).json({ success: false, message: 'Invalid task id' });
      }
      if (is_household === undefined && is_shared_with_partner === undefined) {
        return res.status(400).json({ success: false, message: 'Provide is_household or is_shared_with_partner' });
      }

      const updated = await updateTaskSharingFlags(pool, taskId, userId, {
        isHousehold: is_household,
        isSharedWithPartner: is_shared_with_partner,
      });

      if (!updated) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      res.json({ success: true, task: updated });
    } catch (err) {
      console.error('[partnerships/tasks/share]', err.message);
      res.status(500).json({ success: false, message: 'Failed to update task sharing' });
    }
  });

  // ── GET /api/partnerships/tandem-access ──────────────────────────────────
  // Returns current Tandem subscription state for the authenticated user.
  // Used by settings page + feature gates to decide what to show/allow.
  router.get('/tandem-access', authenticateToken, async (req, res) => {
    try {
      const access = await checkTandemAccess(pool, req.user.id);
      res.json({ success: true, ...access });
    } catch (err) {
      console.error('[partnerships/tandem-access]', err.message);
      res.status(500).json({ success: false, message: 'Failed to check Tandem access' });
    }
  });

  // ── POST /api/partnerships/tandem-activate ────────────────────────────────
  // Called after a successful Tandem Stripe checkout to activate the subscription.
  // Verifies the payment directly with Stripe, then grants tandem_plan + expiry.
  // Also starts the 14-day trial for the partner on the shared partnership row.
  // Body: { session_id: string } — the Stripe checkout session ID from the success redirect
  router.post('/tandem-activate', authenticateToken, async (req, res) => {
    try {
      const { session_id } = req.body;
      if (!session_id) {
        return res.status(400).json({ success: false, message: 'session_id required' });
      }

      // Verify directly with Stripe — the source of truth
      if (!process.env.STRIPE_SECRET_KEY) {
        console.error('[partnerships/tandem-activate] STRIPE_SECRET_KEY not set');
        return res.status(503).json({ success: false, message: 'Payments not configured' });
      }
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription'] });
      const verified = !!session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
      if (!verified) {
        return res.status(402).json({ success: false, message: 'Payment not verified' });
      }
      const interval = session.subscription?.items?.data?.[0]?.price?.recurring?.interval || null;
      const payment = { product_name: session.metadata?.billing || (interval === 'year' ? 'annual' : 'monthly') };

      // Set subscription to expire 1 month or 1 year from now based on product name
      const isAnnual = interval === 'year' || (payment.product_name || '').toLowerCase().includes('annual');
      const expiresAt = new Date();
      if (isAnnual) {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      } else {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      }

      await activateTandemSubscription(pool, req.user.id, expiresAt);

      const access = await checkTandemAccess(pool, req.user.id);
      res.json({ success: true, message: 'Tandem activated!', ...access });
    } catch (err) {
      console.error('[partnerships/tandem-activate]', err.message);
      res.status(500).json({ success: false, message: 'Failed to activate Tandem' });
    }
  });

  // ── POST /api/partnerships/concern ────────────────────────────────────────
  // Partner submits a soft concern about the user — Buddy uses it as coaching context.
  // PRIVACY: Concern text is stored but NEVER shown to the concerned-about user.
  // Buddy receives only the topic area as a weak signal, not the verbatim concern.
  // Body: { concern_text: string, topic_area?: string }
  router.post('/concern', authenticateToken, async (req, res) => {
    try {
      const { concern_text, topic_area } = req.body;
      const fromUserId = req.user.id;

      if (!concern_text || !concern_text.trim()) {
        return res.status(400).json({ success: false, message: 'concern_text is required' });
      }

      // Verify the sender has an active partnership + Tandem access
      const active = await getActivePartnership(pool, fromUserId);
      if (!active) {
        return res.status(403).json({ success: false, message: 'No active partnership.' });
      }

      const access = await checkTandemAccess(pool, fromUserId);
      if (!access.hasTandem) {
        return res.status(403).json({
          success: false,
          code: 'TANDEM_REQUIRED',
          message: 'Tandem subscription required to use accountability features.',
        });
      }

      const concern = await createPartnerConcern(
        pool,
        active.id,
        fromUserId,
        active.partner_id,
        concern_text.trim(),
        topic_area ? topic_area.trim().slice(0, 100) : null
      );

      res.json({
        success: true,
        message: 'Buddy will keep this in mind — coaching only, never nagging.',
        concern: { id: concern.id, topic_area: concern.topic_area, expires_at: concern.expires_at },
      });
    } catch (err) {
      console.error('[partnerships/concern]', err.message);
      res.status(500).json({ success: false, message: 'Failed to save concern' });
    }
  });

  return router;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function buildInviteUrl(req, token) {
  const base = process.env.APP_BASE_URL
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/partner-invite?token=${token}`;
}
