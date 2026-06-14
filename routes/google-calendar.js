'use strict';
/**
 * routes/google-calendar.js — Google Calendar read-only sync.
 * Mounted at /api/gcal.
 *
 * Flow:
 *   1. GET  /api/gcal/auth-url   → return OAuth URL for user to redirect to
 *   2. GET  /api/gcal/callback   → exchange code, store tokens, redirect to /app/calendar
 *   3. POST /api/gcal/sync       → fetch events from GCal, upsert into time_blocks
 *   4. GET  /api/gcal/status     → { connected, lastSync }
 *   5. DELETE /api/gcal/disconnect → clear tokens
 */

const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');

const SCOPES        = 'https://www.googleapis.com/auth/calendar.readonly';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const CALENDAR_URL  = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// ── helpers ──────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = verifyToken(auth.split(' ')[1]);
    req.userId = decoded?.id;
    if (!req.userId) throw new Error('no id');
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function getOAuthBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'app.focusledger.com';
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function refreshAccessToken(pool, userId, refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', body: params });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error || 'Token refresh failed');
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    'UPDATE users SET gcal_access_token=$1, gcal_token_expiry=$2 WHERE id=$3',
    [data.access_token, expiry, userId]
  );
  return data.access_token;
}

async function getValidAccessToken(pool, userId) {
  const { rows } = await pool.query(
    'SELECT gcal_access_token, gcal_refresh_token, gcal_token_expiry FROM users WHERE id=$1',
    [userId]
  );
  const row = rows[0];
  if (!row?.gcal_refresh_token) throw new Error('not_connected');
  if (row.gcal_access_token && new Date(row.gcal_token_expiry) > new Date(Date.now() + 60_000)) {
    return row.gcal_access_token;
  }
  return refreshAccessToken(pool, userId, row.gcal_refresh_token);
}

// ── routes ───────────────────────────────────────────────────────────────────

module.exports = function(pool) {

  // GET /api/gcal/auth-url — returns the Google OAuth URL
  router.get('/auth-url', authMiddleware, (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ success: false, message: 'Google OAuth not configured' });
    }
    const redirectUri = `${getOAuthBase(req)}/api/gcal/callback`;
    const state = Buffer.from(JSON.stringify({
      userId: req.userId,
      token:  req.headers['authorization'].split(' ')[1],
    })).toString('base64url');

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id',     process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         SCOPES);
    url.searchParams.set('access_type',   'offline');
    url.searchParams.set('prompt',        'consent');
    url.searchParams.set('state',         state);

    res.json({ success: true, url: url.toString() });
  });

  // GET /api/gcal/callback — Google redirects here after user grants access
  router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      return res.redirect('/app/calendar?gcal=denied');
    }

    let userId;
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
      userId = parsed.userId;
      if (!userId) throw new Error('no userId in state');
    } catch {
      return res.redirect('/app/calendar?gcal=error');
    }

    const redirectUri = `${getOAuthBase(req)}/api/gcal/callback`;
    try {
      const params = new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      });
      const tokenRes  = await fetch(TOKEN_URL, { method: 'POST', body: params });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error(tokenData.error || 'No access_token');

      const expiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
      await pool.query(
        `UPDATE users
           SET gcal_access_token=$1, gcal_refresh_token=$2, gcal_token_expiry=$3
         WHERE id=$4`,
        [tokenData.access_token, tokenData.refresh_token || null, expiry, userId]
      );
      res.redirect('/app/calendar?gcal=connected');
    } catch (err) {
      console.error('[gcal] callback error:', err.message);
      res.redirect('/app/calendar?gcal=error');
    }
  });

  // GET /api/gcal/status
  router.get('/status', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT gcal_refresh_token, gcal_synced_at FROM users WHERE id=$1',
        [req.userId]
      );
      const row = rows[0];
      res.json({
        success:   true,
        connected: !!row?.gcal_refresh_token,
        lastSync:  row?.gcal_synced_at || null,
      });
    } catch (err) {
      console.error('[gcal] status error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/gcal/sync — fetch events from GCal → upsert time_blocks
  router.post('/sync', authMiddleware, async (req, res) => {
    try {
      const accessToken = await getValidAccessToken(pool, req.userId);

      // Fetch events: now → 14 days out
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const eventsUrl = new URL(CALENDAR_URL);
      eventsUrl.searchParams.set('timeMin',      timeMin);
      eventsUrl.searchParams.set('timeMax',      timeMax);
      eventsUrl.searchParams.set('maxResults',   '100');
      eventsUrl.searchParams.set('singleEvents', 'true');
      eventsUrl.searchParams.set('orderBy',      'startTime');

      const evRes  = await fetch(eventsUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!evRes.ok) {
        const errBody = await evRes.json().catch(() => ({}));
        throw new Error(errBody.error?.message || `GCal API ${evRes.status}`);
      }
      const evData = await evRes.json();
      const events = (evData.items || []).filter(ev => ev.start?.dateTime || ev.start?.date);

      let upserted = 0;
      for (const ev of events) {
        const isAllDay = !!ev.start.date && !ev.start.dateTime;
        if (isAllDay) continue; // skip all-day events — no time slot to place them

        const startDt  = new Date(ev.start.dateTime);
        const endDt    = new Date(ev.end.dateTime);
        const dateStr  = startDt.toISOString().slice(0, 10);
        const startMin = startDt.getHours() * 60 + startDt.getMinutes();
        const endMin   = endDt.getHours() * 60 + endDt.getMinutes();
        const slotKey  = `${Math.floor(startMin / 60)}:00`;

        // Map to time_blocks: use gcal_event_id for dedup
        await pool.query(
          `INSERT INTO time_blocks
             (user_id, title, date, start_time, end_time, slot, source, gcal_event_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'gcal',$7,NOW())
           ON CONFLICT (user_id, gcal_event_id) DO UPDATE SET
             title      = EXCLUDED.title,
             date       = EXCLUDED.date,
             start_time = EXCLUDED.start_time,
             end_time   = EXCLUDED.end_time,
             slot       = EXCLUDED.slot`,
          [req.userId, ev.summary || '(No title)', dateStr,
           `${String(startDt.getHours()).padStart(2,'0')}:${String(startDt.getMinutes()).padStart(2,'0')}`,
           `${String(endDt.getHours()).padStart(2,'0')}:${String(endDt.getMinutes()).padStart(2,'0')}`,
           slotKey, ev.id]
        );
        upserted++;
      }

      await pool.query('UPDATE users SET gcal_synced_at=NOW() WHERE id=$1', [req.userId]);

      res.json({ success: true, synced: upserted });
    } catch (err) {
      if (err.message === 'not_connected') {
        return res.status(400).json({ success: false, message: 'Google Calendar not connected' });
      }
      console.error('[gcal] sync error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // DELETE /api/gcal/disconnect
  router.delete('/disconnect', authMiddleware, async (req, res) => {
    try {
      await pool.query(
        'UPDATE users SET gcal_access_token=NULL, gcal_refresh_token=NULL, gcal_token_expiry=NULL, gcal_synced_at=NULL WHERE id=$1',
        [req.userId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[gcal] disconnect error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  return router;
};
