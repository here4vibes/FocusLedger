const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');

// ============================================================
// Gmail OAuth Configuration
// Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Redirect URI must be registered in Google Cloud Console:
//   https://focusledger.net/api/email/auth/callback
// ============================================================
const GOOGLE_CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REDIRECT_URI  = (process.env.GOOGLE_REDIRECT_URI || 'https://focusledger.net/api/email/auth/callback').trim();
const GMAIL_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';

const isGoogleConfigured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// Self-test: validate Google OAuth credentials at startup
(async function validateGoogleCredentials() {
  if (!isGoogleConfigured()) {
    console.log('[email/startup] Google OAuth not configured (missing client_id or secret)');
    return;
  }
  const maskedId = GOOGLE_CLIENT_ID.slice(0, 12) + '...' + GOOGLE_CLIENT_ID.slice(-20);
  const maskedSecret = GOOGLE_CLIENT_SECRET.slice(0, 8) + '...' + GOOGLE_CLIENT_SECRET.slice(-4);
  console.log('[email/startup] Google OAuth config loaded:',
    'client_id=' + maskedId,
    '| secret=' + maskedSecret + ' (len=' + GOOGLE_CLIENT_SECRET.length + ')',
    '| redirect_uri=' + GOOGLE_REDIRECT_URI
  );
  try {
    // Send a dummy refresh to test if client_id+secret are accepted by Google.
    // valid creds → "invalid_grant" (dummy token rejected, but client authenticated)
    // invalid creds → "invalid_client"
    const testRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: 'dummy-startup-validation'
      })
    });
    const testData = await testRes.json();
    if (testData.error === 'invalid_client') {
      console.error('[email/startup] ⚠️  GOOGLE CREDENTIALS REJECTED — client_id or client_secret is WRONG');
      console.error('[email/startup] Google says:', testData.error_description || testData.error);
    } else if (testData.error === 'invalid_grant') {
      console.log('[email/startup] ✅ Google credentials VALID (invalid_grant = expected for dummy token)');
    } else {
      console.log('[email/startup] Google credential check returned:', JSON.stringify(testData));
    }
  } catch (err) {
    console.warn('[email/startup] Credential check network error:', err.message);
  }
})();

// ============================================================
// Microsoft / Outlook OAuth Configuration
// Requires env vars: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
// Redirect URI must be registered in Azure App Registration:
//   https://focusledger.net/api/email/callback/outlook
// Scopes: Mail.Read, User.Read, offline_access
// ============================================================
const MS_CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MS_REDIRECT_URI  = process.env.MICROSOFT_REDIRECT_URI ||
  'https://focusledger.net/api/email/callback/outlook';
const MS_SCOPE = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access';

const isMicrosoftConfigured = () => !!(MS_CLIENT_ID && MS_CLIENT_SECRET);

// ============================================================
// Yahoo Mail OAuth Configuration
// Requires env vars: YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET
// Redirect URI must be registered in Yahoo Developer Console:
//   https://focusledger.net/api/email/callback/yahoo
// Scope: mail-r (read mail via IMAP + OAuth2)
// ============================================================
const YAHOO_CLIENT_ID     = process.env.YAHOO_CLIENT_ID;
const YAHOO_CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET;
const YAHOO_REDIRECT_URI  = process.env.YAHOO_REDIRECT_URI ||
  'https://focusledger.net/api/email/callback/yahoo';
const YAHOO_SCOPE = 'mail-r openid';

const isYahooConfigured = () => !!(YAHOO_CLIENT_ID && YAHOO_CLIENT_SECRET);

// ============================================================
// Token encryption — AES-256-GCM for tokens stored at rest
// Falls back gracefully to plaintext (legacy unencrypted tokens)
// ============================================================
const _encKey = Buffer.from(
  crypto.createHash('sha256')
    .update(process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || 'focusledger-token-enc')
    .digest('hex'),
  'hex'
).subarray(0, 32);

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const data = Buffer.from(ciphertext, 'base64');
    if (data.length < 29) return ciphertext; // too short → plaintext
    const iv  = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const enc = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext; // unencrypted legacy token — return as-is
  }
}

// ============================================================
// OAuth state signing — ties callback to the initiating user
// ============================================================
const STATE_SECRET = process.env.JWT_SECRET || 'focusledger-email-state';

function signState(userId) {
  const payload = `${userId}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyState(state) {
  try {
    const raw = Buffer.from(state, 'base64url').toString();
    const parts = raw.split(':');
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    // State expires after 10 minutes
    if (Date.now() - Number(ts) > 600000) return null;
    const expected = crypto.createHmac('sha256', STATE_SECRET)
      .update(`${userId}:${ts}`).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    return Number(userId);
  } catch {
    return null;
  }
}

// ============================================================
// Token helpers — raw HTTP, no googleapis npm
// ============================================================
async function exchangeCode(code) {
  console.log('[email/exchangeCode] Exchanging auth code →',
    'redirect_uri=' + GOOGLE_REDIRECT_URI,
    '| client_id=' + GOOGLE_CLIENT_ID.slice(0, 12) + '...',
    '| secret_len=' + GOOGLE_CLIENT_SECRET.length,
    '| code_len=' + (code || '').length
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error('[email/exchangeCode] FAILED:', JSON.stringify(data));
  } else {
    console.log('[email/exchangeCode] Success — token received, expires_in=' + data.expires_in);
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  return res.json();
}

async function getUserEmail(accessToken) {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.emailAddress || null;
}

// Ensure the stored access token is fresh. Returns a valid access token or throws.
async function getValidToken(pool, userId) {
  const result = await pool.query(
    'SELECT access_token, refresh_token, token_expires_at FROM email_connections WHERE user_id = $1 AND provider = $2',
    [userId, 'gmail']
  );
  if (!result.rows.length) throw new Error('No connection found');

  const { access_token: encAccess, refresh_token: encRefresh, token_expires_at } = result.rows[0];
  // Decrypt tokens — handles both encrypted and legacy plaintext tokens
  const accessToken  = decryptToken(encAccess);
  const refreshToken = decryptToken(encRefresh);

  // If token expires in less than 2 minutes, refresh
  const expiresAt = token_expires_at ? new Date(token_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < 120000) {
    if (!refreshToken) {
      const err = new Error('Refresh token missing — please reconnect your Gmail account');
      err.code = 'RECONNECT_REQUIRED';
      throw err;
    }
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed.error) {
      console.error('[email/getValidToken] Google refresh error:', refreshed.error, refreshed.error_description || '');
      const err = new Error(`Token refresh failed: ${refreshed.error}`);
      err.code = 'RECONNECT_REQUIRED';
      throw err;
    }

    const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
    await pool.query(
      `UPDATE email_connections
       SET access_token = $1, token_expires_at = $2
       WHERE user_id = $3 AND provider = $4`,
      [encryptToken(refreshed.access_token), newExpiry, userId, 'gmail']
    );
    return refreshed.access_token;
  }

  return accessToken;
}

// ============================================================
// Gmail API helpers
// ============================================================
async function gmailListMessages(accessToken, pageToken, query) {
  const params = new URLSearchParams({
    maxResults: '25',
    labelIds: 'INBOX'
  });
  if (pageToken) params.set('pageToken', pageToken);
  if (query) params.set('q', query);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

async function gmailGetMessage(accessToken, messageId, format = 'metadata') {
  const params = new URLSearchParams({ format });
  if (format === 'metadata') {
    params.append('metadataHeaders', 'Subject');
    params.append('metadataHeaders', 'From');
    params.append('metadataHeaders', 'Date');
  }
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

function decodeBase64(str) {
  if (!str) return '';
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function extractTextFromPart(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body && part.body.data) {
    return decodeBase64(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractTextFromPart(sub);
      if (text) return text;
    }
  }
  return '';
}

function parseMessageHeaders(headers) {
  const map = {};
  if (!headers) return map;
  for (const h of headers) {
    map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

// ============================================================
// Outlook (Microsoft Graph) helpers
// ============================================================

async function exchangeOutlookCode(code) {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      redirect_uri:  MS_REDIRECT_URI,
      grant_type:    'authorization_code'
    })
  });
  return res.json();
}

async function refreshOutlookToken(refreshToken) {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type:    'refresh_token',
      scope:         MS_SCOPE
    })
  });
  return res.json();
}

async function getOutlookUserEmail(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  return data.mail || data.userPrincipalName || null;
}

async function getValidOutlookToken(pool, userId) {
  const result = await pool.query(
    'SELECT access_token, refresh_token, token_expires_at FROM email_connections WHERE user_id = $1 AND provider = $2',
    [userId, 'outlook']
  );
  if (!result.rows.length) throw new Error('No connection found');

  const { access_token: encAccess, refresh_token: encRefresh, token_expires_at } = result.rows[0];
  const accessToken  = decryptToken(encAccess);
  const refreshToken = decryptToken(encRefresh);

  const expiresAt = token_expires_at ? new Date(token_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < 120000) {
    const refreshed = await refreshOutlookToken(refreshToken);
    if (refreshed.error) throw new Error(`Token refresh failed: ${refreshed.error}`);
    const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
    await pool.query(
      `UPDATE email_connections
       SET access_token = $1, token_expires_at = $2, updated_at = NOW()
       WHERE user_id = $3 AND provider = $4`,
      [encryptToken(refreshed.access_token), newExpiry, userId, 'outlook']
    );
    return refreshed.access_token;
  }
  return accessToken;
}

async function graphListMessages(accessToken, skipToken) {
  let url = 'https://graph.microsoft.com/v1.0/me/messages' +
    '?$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,isRead' +
    '&$orderby=receivedDateTime%20desc';
  if (skipToken) url += `&$skipToken=${encodeURIComponent(skipToken)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  return res.json();
}

async function graphGetMessage(accessToken, messageId) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}` +
      '?$select=id,subject,from,receivedDateTime,bodyPreview,body,isRead',
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  );
  return res.json();
}

// ============================================================
// Yahoo Mail helpers (OAuth2 + IMAP)
// ============================================================

async function exchangeYahooCode(code) {
  const creds = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    },
    body: new URLSearchParams({
      code,
      redirect_uri:  YAHOO_REDIRECT_URI,
      grant_type:    'authorization_code'
    })
  });
  return res.json();
}

async function refreshYahooToken(refreshToken) {
  const creds = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      redirect_uri:  YAHOO_REDIRECT_URI,
      grant_type:    'refresh_token'
    })
  });
  return res.json();
}

async function getYahooUserEmail(accessToken) {
  const res = await fetch('https://api.login.yahoo.com/openid/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  return data.email || null;
}

async function getValidYahooToken(pool, userId) {
  const result = await pool.query(
    'SELECT access_token, refresh_token, token_expires_at, email_address FROM email_connections WHERE user_id = $1 AND provider = $2',
    [userId, 'yahoo']
  );
  if (!result.rows.length) throw new Error('No connection found');

  const { access_token: encAccess, refresh_token: encRefresh, token_expires_at, email_address } = result.rows[0];
  const accessToken  = decryptToken(encAccess);
  const refreshToken = decryptToken(encRefresh);

  const expiresAt = token_expires_at ? new Date(token_expires_at) : null;
  if (!expiresAt || expiresAt.getTime() - Date.now() < 120000) {
    const refreshed = await refreshYahooToken(refreshToken);
    if (refreshed.error) throw new Error(`Token refresh failed: ${refreshed.error}`);
    const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
    await pool.query(
      `UPDATE email_connections
       SET access_token = $1, token_expires_at = $2, updated_at = NOW()
       WHERE user_id = $3 AND provider = $4`,
      [encryptToken(refreshed.access_token), newExpiry, userId, 'yahoo']
    );
    return { token: refreshed.access_token, emailAddress: email_address };
  }
  return { token: accessToken, emailAddress: email_address };
}

// Fetch Yahoo inbox via IMAP with XOAUTH2
// Uses the `imap` package (lightweight pure-Node IMAP client)
async function yahooListMessages(emailAddress, accessToken) {
  // Lazy require — avoids hard crash if imap package not installed yet
  let Imap;
  try { Imap = require('imap'); }
  catch { throw new Error('imap package not available'); }

  return new Promise((resolve, reject) => {
    const xoauth2Token = Buffer.from(
      `user=${emailAddress}\x01auth=Bearer ${accessToken}\x01\x01`
    ).toString('base64');

    const imap = new Imap({
      user:        emailAddress,
      xoauth2:     xoauth2Token,
      host:        'imap.mail.yahoo.com',
      port:        993,
      tls:         true,
      tlsOptions:  { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 15000
    });

    const messages = [];
    let fetchError = null;

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { fetchError = err; imap.end(); return; }
        if (!box.messages.total) { imap.end(); return; }

        const total = box.messages.total;
        const start = Math.max(1, total - 24);

        const f = imap.seq.fetch(`${start}:${total}`, {
          bodies: 'HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)',
          struct: true
        });

        f.on('message', (msg, seqno) => {
          const msgData = { seqno, id: null, subject: '(no subject)', from: '', date: '', snippet: '', flags: [] };

          msg.on('body', (stream) => {
            let buf = '';
            stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
            stream.once('end', () => {
              const parsed = Imap.parseHeader(buf);
              msgData.subject = (parsed.subject || ['(no subject)'])[0] || '(no subject)';
              msgData.from    = (parsed.from || [''])[0] || '';
              msgData.date    = (parsed.date || [''])[0] || '';
              const msgId     = (parsed['message-id'] || [''])[0];
              msgData.id      = msgId || `yahoo-seq-${seqno}`;
            });
          });

          msg.once('attributes', (attrs) => {
            msgData.uid   = attrs.uid;
            msgData.flags = attrs.flags || [];
          });

          msg.once('end', () => { messages.push(msgData); });
        });

        f.once('error', (err) => { fetchError = err; });
        f.once('end', () => { imap.end(); });
      });
    });

    imap.once('error', (err) => { reject(err); });
    imap.once('end', () => {
      if (fetchError) return reject(fetchError);
      messages.sort((a, b) => b.seqno - a.seqno);
      resolve(messages.slice(0, 25));
    });

    imap.connect();
  });
}

// ============================================================
// Routes
// ============================================================

module.exports = function(pool) {

  // ── Status: is Gmail connected? is Google configured?
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT email_address, connected_at FROM email_connections WHERE user_id = $1 AND provider = $2',
        [req.user.id, 'gmail']
      );
      res.json({
        google_configured: isGoogleConfigured(),
        connected: result.rows.length > 0,
        email_address: result.rows[0]?.email_address || null,
        connected_at: result.rows[0]?.connected_at || null
      });
    } catch (err) {
      console.error('[email/status]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ── Initiate OAuth — returns the Google consent URL
  router.get('/auth/start', authenticateToken, async (req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Gmail integration is not yet configured. Contact support to enable it.'
      });
    }

    const isPro = await checkProStatus(pool, req.user.id);
    if (!isPro) {
      return res.status(403).json({ success: false, message: 'Pro required' });
    }

    const state = signState(req.user.id);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GMAIL_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);

    res.json({ success: true, url: url.toString() });
  });

  // ── OAuth callback — called by Google after user grants consent
  // Note: no JWT here — authenticated via the signed state param
  router.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error('[email/callback] OAuth error:', error);
      return res.redirect('/email?error=oauth_denied');
    }

    if (!code || !state) {
      return res.redirect('/email?error=invalid_callback');
    }

    const userId = verifyState(state);
    if (!userId) {
      return res.redirect('/email?error=invalid_state');
    }

    try {
      const tokens = await exchangeCode(code);
      if (tokens.error) {
        console.error('[email/callback] Token exchange error:', tokens.error,
          tokens.error_description || '', '| redirect_uri=' + GOOGLE_REDIRECT_URI);
        // Map Google error codes to specific frontend error keys
        const errorKey = tokens.error === 'invalid_client' ? 'credentials_invalid'
          : tokens.error === 'redirect_uri_mismatch' ? 'redirect_mismatch'
          : tokens.error === 'invalid_grant' ? 'code_expired'
          : 'token_exchange';
        return res.redirect('/email?error=' + errorKey);
      }

      const emailAddress = await getUserEmail(tokens.access_token);
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

      await pool.query(
        `INSERT INTO email_connections (user_id, provider, email_address, access_token, refresh_token, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, provider) DO UPDATE
           SET email_address = EXCLUDED.email_address,
               access_token = EXCLUDED.access_token,
               refresh_token = COALESCE(EXCLUDED.refresh_token, email_connections.refresh_token),
               token_expires_at = EXCLUDED.token_expires_at,
               connected_at = NOW()`,
        [userId, 'gmail', emailAddress, encryptToken(tokens.access_token), tokens.refresh_token ? encryptToken(tokens.refresh_token) : null, expiresAt]
      );

      res.redirect('/email?connected=1');
    } catch (err) {
      console.error('[email/callback] Error:', err);
      res.redirect('/email?error=server_error');
    }
  });

  // ── Inbox: list messages
  router.get('/inbox', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) {
        return res.status(403).json({ success: false, message: 'Pro required' });
      }

      const accessToken = await getValidToken(pool, req.user.id);
      const { pageToken, q } = req.query;

      const list = await gmailListMessages(accessToken, pageToken, q);
      if (list.error) {
        return res.status(400).json({ success: false, message: list.error.message });
      }

      if (!list.messages || list.messages.length === 0) {
        return res.json({ success: true, messages: [], nextPageToken: null });
      }

      // Fetch metadata for each message in parallel (capped at 25)
      const messages = await Promise.all(
        list.messages.map(async (m) => {
          try {
            const msg = await gmailGetMessage(accessToken, m.id, 'metadata');
            const headers = parseMessageHeaders(msg.payload?.headers);
            return {
              id: m.id,
              thread_id: m.threadId,
              subject: headers['subject'] || '(no subject)',
              from: headers['from'] || '',
              date: headers['date'] || '',
              snippet: msg.snippet || '',
              label_ids: msg.labelIds || []
            };
          } catch {
            return { id: m.id, thread_id: m.threadId, subject: '(error)', from: '', date: '', snippet: '' };
          }
        })
      );

      res.json({
        success: true,
        messages,
        next_page_token: list.nextPageToken || null,
        result_size_estimate: list.resultSizeEstimate
      });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Gmail account connected' });
      }
      if (err.code === 'RECONNECT_REQUIRED') {
        return res.status(401).json({
          success: false,
          message: 'Your Gmail connection has expired. Please disconnect and reconnect your account.',
          reconnect_required: true
        });
      }
      console.error('[email/inbox]', err);
      res.status(500).json({ success: false, message: 'Failed to fetch inbox' });
    }
  });

  // ── Message detail: subject, from, date, full body
  router.get('/message/:id', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) {
        return res.status(403).json({ success: false, message: 'Pro required' });
      }

      const accessToken = await getValidToken(pool, req.user.id);
      const msg = await gmailGetMessage(accessToken, req.params.id, 'full');

      if (msg.error) {
        return res.status(400).json({ success: false, message: msg.error.message });
      }

      const headers = parseMessageHeaders(msg.payload?.headers);
      const body = extractTextFromPart(msg.payload);

      res.json({
        success: true,
        id: msg.id,
        thread_id: msg.threadId,
        subject: headers['subject'] || '(no subject)',
        from: headers['from'] || '',
        date: headers['date'] || '',
        snippet: msg.snippet || '',
        body: body.trim(),
        label_ids: msg.labelIds || []
      });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Gmail account connected' });
      }
      if (err.code === 'RECONNECT_REQUIRED') {
        return res.status(401).json({
          success: false,
          message: 'Your Gmail connection has expired. Please disconnect and reconnect your account.',
          reconnect_required: true
        });
      }
      console.error('[email/message]', err);
      res.status(500).json({ success: false, message: 'Failed to fetch message' });
    }
  });

  // ── Create task from email
  router.post('/create-task', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) {
        return res.status(403).json({ success: false, message: 'Pro required' });
      }

      // email_subject and email_from accepted but not stored — available for future metadata use
      const { title, notes, due_date, email_id, email_subject: _email_subject, email_from: _email_from } = req.body;
      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Task title is required' });
      }

      // Enforce 10-task limit for free users (Pro users skip this, but email tasks are Pro-only)
      // For Pro users, no limit — but we still check for completeness / future downgrades
      if (!isPro) {
        const activeCount = await pool.query(
          'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
          [req.user.id]
        );
        if (parseInt(activeCount.rows[0].count) >= 10) {
          return res.status(402).json({
            success: false,
            message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Pro.',
            code: 'TASK_LIMIT_REACHED',
            upgrade_required: true
          });
        }
      }

      // Validate due_date if provided
      const parsedDueDate = due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;

      const result = await pool.query(
        `INSERT INTO tasks (user_id, title, description, due_date, source, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, description, due_date, source, source_ref, created_at`,
        [
          req.user.id,
          title.trim().slice(0, 255),
          notes ? notes.trim().slice(0, 2000) : null,
          parsedDueDate,
          'email',
          email_id || null
        ]
      );

      res.json({
        success: true,
        task: result.rows[0],
        message: `Task created from email: "${title.trim()}"`
      });
    } catch (err) {
      // If source/source_ref columns don't exist yet, fall back gracefully
      if (err.code === '42703') {
        try {
          const { title, notes } = req.body;
          const result = await pool.query(
            `INSERT INTO tasks (user_id, title, description)
             VALUES ($1, $2, $3)
             RETURNING id, title, description, created_at`,
            [req.user.id, title.trim().slice(0, 255), notes ? notes.trim().slice(0, 2000) : null]
          );
          return res.json({ success: true, task: result.rows[0] });
        } catch (e2) {
          console.error('[email/create-task fallback]', e2);
        }
      }
      console.error('[email/create-task]', err);
      res.status(500).json({ success: false, message: 'Failed to create task' });
    }
  });

  // ── Disconnect Gmail
  router.delete('/disconnect', authenticateToken, async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM email_connections WHERE user_id = $1 AND provider = $2',
        [req.user.id, 'gmail']
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[email/disconnect]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ============================================================
  // Email Suggestions — auto-scan inbox for actionable emails
  // ============================================================

  // ── Actionability scoring engine
  function scoreEmail(subject, from, snippet) {
    let score = 0;
    const reasons = [];

    const lSubject = (subject || '').toLowerCase();
    const lFrom = (from || '').toLowerCase();
    const lSnippet = (snippet || '').toLowerCase();
    const combined = lSubject + ' ' + lSnippet;

    // ── Noise filters — skip these
    // no-reply senders
    if (/noreply|no-reply|donotreply|do-not-reply|notifications?@|alerts?@|updates?@|mailer@|bounce@/.test(lFrom)) {
      return { score: 0, reasons: [] };
    }
    // Mailing list / bulk indicators
    if (/unsubscribe|list-unsubscribe|newsletter|marketing|promo|offer|deal|sale|discount/.test(combined)) {
      return { score: 0, reasons: [] };
    }
    // Automated system emails
    if (/automated message|do not reply|this is an automated|auto-generated/.test(combined)) {
      return { score: 0, reasons: [] };
    }

    // ── Positive signals

    // Action language in subject
    const actionWords = [
      'action required', 'action needed', 'please reply', 'please respond',
      'your response', 'follow up', 'follow-up', 'reminder:', 'reminder -',
      'urgent:', 'urgent -', 'asap', 'please confirm', 'confirm your',
      'please review', 'needs your', 'awaiting your', 'waiting for you',
      'please sign', 'please approve', 'please complete', 'please submit',
      'your approval', 'requires your', 'requires approval', 'next steps',
      'can you', 'could you', 'would you', 'need you to'
    ];
    for (const w of actionWords) {
      if (combined.includes(w)) {
        score += 0.3;
        reasons.push('Action requested');
        break;
      }
    }

    // Due date / deadline signals
    const datePatterns = [
      /\bdue\s+(by|date|on)\b/i,
      /\bdeadline\b/i,
      /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-])/i,
      /\buntil\b.*\b(tomorrow|tonight|friday|monday|eod|end of day)\b/i,
      /\btoday\b|\btomorrow\b/i,
      /\bexpires?\b|\bexpiration\b/i
    ];
    for (const p of datePatterns) {
      if (p.test(combined)) {
        score += 0.35;
        reasons.push('Contains due date');
        break;
      }
    }

    // Financial / invoice signals
    const financePatterns = [
      /\$[\d,]+(\.\d{2})?/,
      /\binvoice\b/i,
      /\bpayment\s+(due|required|needed|requested|overdue)\b/i,
      /\bamount\s+due\b/i,
      /\bstatement\b/i,
      /\bquote\b|\bproposal\b/i,
      /\brefund\b|\bcharge\b|\bsubscription\b/i
    ];
    for (const p of financePatterns) {
      if (p.test(combined)) {
        score += 0.25;
        reasons.push('Invoice detected');
        break;
      }
    }

    // Direct personal question / reply needed
    const questionWords = ['?', 'let me know', 'thoughts?', 'feedback?', 'available?', 'free?'];
    for (const w of questionWords) {
      if (combined.includes(w)) {
        score += 0.15;
        reasons.push('Reply requested');
        break;
      }
    }

    // Meeting / scheduling signals
    if (/\bmeeting\b|\bschedule\b|\bcall\b|\binterview\b|\bappointment\b/.test(lSubject)) {
      score += 0.2;
      reasons.push('Meeting or call');
    }

    // Deduplicate reasons
    const uniqueReasons = [...new Set(reasons)];
    return { score: Math.min(score, 1.0), reasons: uniqueReasons };
  }

  // Extract suggested title from subject
  function suggestTitle(subject, from) {
    if (!subject || subject === '(no subject)') {
      const fromName = from ? from.replace(/<[^>]+>/, '').trim() : 'unknown';
      return `Follow up with ${fromName}`;
    }
    // Strip common prefixes
    const cleaned = subject.replace(/^(re:|fwd:|fw:|=\?utf-8)/gi, '').trim();
    return cleaned.slice(0, 200) || subject.slice(0, 200);
  }

  // Extract amount from subject/snippet
  function extractAmount(text) {
    const match = (text || '').match(/\$([0-9,]+(\.\d{2})?)/);
    if (!match) return null;
    const val = parseFloat(match[1].replace(/,/g, ''));
    return isNaN(val) ? null : val;
  }

  // Extract due date from subject/snippet (simple heuristic)
  function extractDueDate(text) {
    const t = (text || '').toLowerCase();
    const now = new Date();
    // "tomorrow"
    if (/\btomorrow\b/.test(t)) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    }
    // "by [weekday]"
    const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    for (let i = 0; i < weekdays.length; i++) {
      if (new RegExp('\\b' + weekdays[i] + '\\b').test(t)) {
        const d = new Date(now);
        const current = d.getDay();
        const diff = (i - current + 7) % 7 || 7;
        d.setDate(d.getDate() + diff);
        return d.toISOString().split('T')[0];
      }
    }
    return null;
  }

  // ── GET /api/email/suggestions — list pending suggestions
  router.get('/suggestions', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      const result = await pool.query(
        `SELECT s.id, s.message_id, s.suggested_title, s.suggested_due_date,
                s.suggested_amount, s.confidence_score, s.confidence_reasons,
                s.source_subject, s.source_from, s.source_date, s.status,
                s.created_at
         FROM email_suggestions s
         WHERE s.user_id = $1 AND s.status = 'pending'
         ORDER BY s.confidence_score DESC, s.created_at DESC
         LIMIT 10`,
        [req.user.id]
      );

      res.json({ success: true, suggestions: result.rows });
    } catch (err) {
      console.error('[email/suggestions GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ── POST /api/email/suggestions/scan — scan inbox and generate suggestions
  router.post('/suggestions/scan', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      // Check autosuggest is enabled for user
      const prefRes = await pool.query(
        'SELECT email_autosuggest_enabled FROM users WHERE id = $1',
        [req.user.id]
      );
      if (prefRes.rows.length && prefRes.rows[0].email_autosuggest_enabled === false) {
        return res.json({ success: true, added: 0, message: 'Auto-suggest is disabled' });
      }

      const accessToken = await getValidToken(pool, req.user.id);

      // Get the email_connections id for this user
      const connRes = await pool.query(
        'SELECT id FROM email_connections WHERE user_id = $1 AND provider = $2',
        [req.user.id, 'gmail']
      );
      const emailAccountId = connRes.rows[0]?.id || null;

      // Fetch up to 30 recent inbox emails
      const list = await gmailListMessages(accessToken, null, 'in:inbox newer_than:7d');
      if (!list.messages || list.messages.length === 0) {
        return res.json({ success: true, added: 0 });
      }

      // Get already-known message IDs (dismissed or already suggested)
      const existingRes = await pool.query(
        'SELECT message_id FROM email_suggestions WHERE user_id = $1',
        [req.user.id]
      );
      const knownIds = new Set(existingRes.rows.map(r => r.message_id));

      // Also skip emails already used as task sources
      const taskSourceRes = await pool.query(
        "SELECT source_ref FROM tasks WHERE user_id = $1 AND source = 'email' AND source_ref IS NOT NULL",
        [req.user.id]
      );
      for (const r of taskSourceRes.rows) knownIds.add(r.source_ref);

      const candidates = list.messages.slice(0, 30).filter(m => !knownIds.has(m.id));
      if (candidates.length === 0) {
        return res.json({ success: true, added: 0 });
      }

      // Fetch metadata for candidates (cap parallel requests)
      const batchSize = 15;
      const batch = candidates.slice(0, batchSize);
      const metaList = await Promise.all(
        batch.map(async (m) => {
          try {
            const msg = await gmailGetMessage(accessToken, m.id, 'metadata');
            const headers = parseMessageHeaders(msg.payload?.headers);
            return {
              id: m.id,
              subject: headers['subject'] || '(no subject)',
              from: headers['from'] || '',
              date: headers['date'] || '',
              snippet: msg.snippet || ''
            };
          } catch { return null; }
        })
      );

      // Score and insert candidates above threshold
      const THRESHOLD = 0.4;
      let added = 0;

      for (const meta of metaList) {
        if (!meta) continue;
        const { score, reasons } = scoreEmail(meta.subject, meta.from, meta.snippet);
        if (score < THRESHOLD) continue;

        const title = suggestTitle(meta.subject, meta.from);
        const amount = extractAmount(meta.subject + ' ' + meta.snippet);
        const dueDate = extractDueDate(meta.subject + ' ' + meta.snippet);

        try {
          await pool.query(
            `INSERT INTO email_suggestions
               (user_id, email_account_id, message_id, suggested_title, suggested_due_date,
                suggested_amount, confidence_score, confidence_reasons,
                source_subject, source_from, source_date, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
             ON CONFLICT (user_id, message_id) DO NOTHING`,
            [
              req.user.id, emailAccountId, meta.id,
              title, dueDate || null, amount || null,
              score.toFixed(2), reasons,
              meta.subject, meta.from, meta.date
            ]
          );
          added++;
        } catch (insertErr) {
          console.error('[email/suggestions scan insert]', insertErr);
        }
      }

      res.json({ success: true, added });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Gmail account connected' });
      }
      if (err.code === 'RECONNECT_REQUIRED') {
        return res.status(401).json({
          success: false,
          message: 'Your Gmail connection has expired. Please disconnect and reconnect your account.',
          reconnect_required: true
        });
      }
      console.error('[email/suggestions scan]', err);
      res.status(500).json({ success: false, message: 'Failed to scan inbox' });
    }
  });

  // ── POST /api/email/suggestions/:id/accept — create task from suggestion
  router.post('/suggestions/:id/accept', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      const suggRes = await pool.query(
        'SELECT * FROM email_suggestions WHERE id = $1 AND user_id = $2 AND status = $3',
        [req.params.id, req.user.id, 'pending']
      );
      if (!suggRes.rows.length) {
        return res.status(404).json({ success: false, message: 'Suggestion not found' });
      }

      const sugg = suggRes.rows[0];
      const { title: customTitle, notes: customNotes, due_date: customDueDate } = req.body;
      const finalTitle = (customTitle || sugg.suggested_title).trim().slice(0, 255);
      const finalNotes = customNotes ? customNotes.trim().slice(0, 2000) : null;
      // Prefer user-edited due date, fall back to suggestion's detected date
      const rawDueDate = customDueDate !== undefined ? customDueDate : sugg.suggested_due_date;
      const finalDueDate = rawDueDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDueDate) ? rawDueDate : (sugg.suggested_due_date || null);

      // Create the task
      let taskResult;
      try {
        taskResult = await pool.query(
          `INSERT INTO tasks (user_id, title, description, due_date, source, source_ref)
           VALUES ($1, $2, $3, $4, 'email', $5)
           RETURNING id, title, description, due_date, created_at`,
          [req.user.id, finalTitle, finalNotes, finalDueDate, sugg.message_id]
        );
      } catch (colErr) {
        if (colErr.code === '42703') {
          taskResult = await pool.query(
            'INSERT INTO tasks (user_id, title, description) VALUES ($1, $2, $3) RETURNING id, title, description, created_at',
            [req.user.id, finalTitle, finalNotes]
          );
        } else throw colErr;
      }

      const task = taskResult.rows[0];

      // Mark suggestion accepted + link task
      await pool.query(
        `UPDATE email_suggestions SET status = 'accepted', linked_task_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [task.id, sugg.id]
      );

      res.json({ success: true, task });
    } catch (err) {
      console.error('[email/suggestions accept]', err);
      res.status(500).json({ success: false, message: 'Failed to create task' });
    }
  });

  // ── POST /api/email/suggestions/:id/dismiss — dismiss a suggestion
  router.post('/suggestions/:id/dismiss', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE email_suggestions SET status = 'dismissed', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING id`,
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Suggestion not found' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[email/suggestions dismiss]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ── GET /api/email/suggestions/settings — get autosuggest preference
  router.get('/suggestions/settings', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT email_autosuggest_enabled FROM users WHERE id = $1',
        [req.user.id]
      );
      const enabled = result.rows[0]?.email_autosuggest_enabled !== false;
      res.json({ success: true, email_autosuggest_enabled: enabled });
    } catch (err) {
      console.error('[email/suggestions settings GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ── PUT /api/email/suggestions/settings — update autosuggest preference
  router.put('/suggestions/settings', authenticateToken, async (req, res) => {
    try {
      const { email_autosuggest_enabled } = req.body;
      if (typeof email_autosuggest_enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'email_autosuggest_enabled must be boolean' });
      }
      await pool.query(
        'UPDATE users SET email_autosuggest_enabled = $1 WHERE id = $2',
        [email_autosuggest_enabled, req.user.id]
      );
      res.json({ success: true, email_autosuggest_enabled });
    } catch (err) {
      console.error('[email/suggestions settings PUT]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ============================================================
  // Unified account management
  // ============================================================

  // ── List all connected email accounts for the user
  router.get('/accounts', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, provider, email_address, is_active,
                connected_at,
                CASE WHEN token_expires_at IS NULL THEN false
                     WHEN token_expires_at > NOW() THEN true
                     ELSE false END AS token_valid
         FROM email_connections
         WHERE user_id = $1
         ORDER BY connected_at DESC`,
        [req.user.id]
      );
      const providers = {
        gmail:   { configured: isGoogleConfigured(),    label: 'Gmail'   },
        outlook: { configured: isMicrosoftConfigured(), label: 'Outlook' },
        yahoo:   { configured: isYahooConfigured(),     label: 'Yahoo'   }
      };
      res.json({ success: true, accounts: result.rows, providers });
    } catch (err) {
      console.error('[email/accounts GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ── Disconnect a specific account by DB row id
  router.delete('/accounts/:id', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM email_connections WHERE id = $1 AND user_id = $2 RETURNING id, provider',
        [req.params.id, req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Account not found' });
      }
      res.json({ success: true, deleted: result.rows[0] });
    } catch (err) {
      console.error('[email/accounts/:id DELETE]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ============================================================
  // Outlook OAuth routes
  // ============================================================

  // ── Initiate Outlook OAuth — returns Microsoft consent URL
  router.get('/auth/outlook/start', authenticateToken, async (req, res) => {
    if (!isMicrosoftConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Outlook integration is not yet configured. Contact support to enable it.'
      });
    }

    const isPro = await checkProStatus(pool, req.user.id);
    if (!isPro) {
      return res.status(403).json({ success: false, message: 'Pro required' });
    }

    const state = signState(req.user.id);
    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    url.searchParams.set('client_id',     MS_CLIENT_ID);
    url.searchParams.set('redirect_uri',  MS_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope',         MS_SCOPE);
    url.searchParams.set('state',         state);
    url.searchParams.set('prompt',        'select_account');

    res.json({ success: true, url: url.toString() });
  });

  // ── Outlook OAuth callback — called by Microsoft after user consents
  // Authenticated via signed state param (no JWT needed)
  router.get('/callback/outlook', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error('[email/callback/outlook] OAuth error:', error);
      return res.redirect('/email?error=oauth_denied');
    }
    if (!code || !state) {
      return res.redirect('/email?error=invalid_callback');
    }

    const userId = verifyState(state);
    if (!userId) {
      return res.redirect('/email?error=invalid_state');
    }

    try {
      const tokens = await exchangeOutlookCode(code);
      if (tokens.error) {
        console.error('[email/callback/outlook] Token exchange error:', tokens.error);
        return res.redirect('/email?error=token_exchange');
      }

      const emailAddress = await getOutlookUserEmail(tokens.access_token);
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

      await pool.query(
        `INSERT INTO email_connections
           (user_id, provider, email_address, access_token, refresh_token, token_expires_at, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (user_id, provider) DO UPDATE
           SET email_address    = EXCLUDED.email_address,
               access_token     = EXCLUDED.access_token,
               refresh_token    = COALESCE(EXCLUDED.refresh_token, email_connections.refresh_token),
               token_expires_at = EXCLUDED.token_expires_at,
               is_active        = TRUE,
               connected_at     = NOW()`,
        [
          userId, 'outlook', emailAddress,
          encryptToken(tokens.access_token),
          tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
          expiresAt
        ]
      );

      res.redirect('/email?connected=1&provider=outlook');
    } catch (err) {
      console.error('[email/callback/outlook] Error:', err);
      res.redirect('/email?error=server_error');
    }
  });

  // ── Outlook inbox (paginated via Microsoft Graph)
  router.get('/outlook/inbox', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      const accessToken = await getValidOutlookToken(pool, req.user.id);
      const { skipToken } = req.query;

      const data = await graphListMessages(accessToken, skipToken);
      if (data.error) {
        const status = data.error.code === 'InvalidAuthenticationToken' ? 401 : 400;
        return res.status(status).json({ success: false, message: data.error.message });
      }

      const messages = (data.value || []).map(m => ({
        id:        m.id,
        subject:   m.subject || '(no subject)',
        from:      m.from?.emailAddress?.address || '',
        from_name: m.from?.emailAddress?.name    || '',
        date:      m.receivedDateTime || '',
        snippet:   m.bodyPreview      || '',
        is_read:   m.isRead,
        label_ids: m.isRead ? [] : ['UNREAD']
      }));

      let nextSkipToken = null;
      const nextLink = data['@odata.nextLink'];
      if (nextLink) {
        const m = nextLink.match(/[?&]\$skipToken=([^&]+)/);
        if (m) nextSkipToken = decodeURIComponent(m[1]);
      }

      res.json({ success: true, messages, next_skip_token: nextSkipToken });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Outlook account connected' });
      }
      console.error('[email/outlook/inbox]', err);
      res.status(500).json({ success: false, message: 'Failed to fetch Outlook inbox' });
    }
  });

  // ── Outlook message detail
  router.get('/outlook/message/:id', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      const accessToken = await getValidOutlookToken(pool, req.user.id);
      const data = await graphGetMessage(accessToken, req.params.id);

      if (data.error) {
        return res.status(400).json({ success: false, message: data.error.message });
      }

      res.json({
        success:   true,
        id:        data.id,
        subject:   data.subject || '(no subject)',
        from:      data.from?.emailAddress?.address || '',
        from_name: data.from?.emailAddress?.name    || '',
        date:      data.receivedDateTime || '',
        snippet:   data.bodyPreview || '',
        body:      data.body?.content   || '',
        body_type: data.body?.contentType || 'text',
        is_read:   data.isRead
      });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Outlook account connected' });
      }
      console.error('[email/outlook/message]', err);
      res.status(500).json({ success: false, message: 'Failed to fetch message' });
    }
  });

  // ============================================================
  // Yahoo OAuth + IMAP routes
  // ============================================================

  // ── Initiate Yahoo OAuth — returns Yahoo consent URL
  router.get('/auth/yahoo/start', authenticateToken, async (req, res) => {
    if (!isYahooConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Yahoo Mail integration is not yet configured. Contact support to enable it.'
      });
    }

    const isPro = await checkProStatus(pool, req.user.id);
    if (!isPro) {
      return res.status(403).json({ success: false, message: 'Pro required' });
    }

    const state = signState(req.user.id);
    const url = new URL('https://api.login.yahoo.com/oauth2/request_auth');
    url.searchParams.set('client_id',     YAHOO_CLIENT_ID);
    url.searchParams.set('redirect_uri',  YAHOO_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope',         YAHOO_SCOPE);
    url.searchParams.set('state',         state);

    res.json({ success: true, url: url.toString() });
  });

  // ── Yahoo OAuth callback — called by Yahoo after user consents
  router.get('/callback/yahoo', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.error('[email/callback/yahoo] OAuth error:', error);
      return res.redirect('/email?error=oauth_denied');
    }
    if (!code || !state) {
      return res.redirect('/email?error=invalid_callback');
    }

    const userId = verifyState(state);
    if (!userId) {
      return res.redirect('/email?error=invalid_state');
    }

    try {
      const tokens = await exchangeYahooCode(code);
      if (tokens.error) {
        console.error('[email/callback/yahoo] Token exchange error:', tokens.error);
        return res.redirect('/email?error=token_exchange');
      }

      const emailAddress = await getYahooUserEmail(tokens.access_token);
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

      await pool.query(
        `INSERT INTO email_connections
           (user_id, provider, email_address, access_token, refresh_token, token_expires_at, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (user_id, provider) DO UPDATE
           SET email_address    = EXCLUDED.email_address,
               access_token     = EXCLUDED.access_token,
               refresh_token    = COALESCE(EXCLUDED.refresh_token, email_connections.refresh_token),
               token_expires_at = EXCLUDED.token_expires_at,
               is_active        = TRUE,
               connected_at     = NOW()`,
        [
          userId, 'yahoo', emailAddress,
          encryptToken(tokens.access_token),
          tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
          expiresAt
        ]
      );

      res.redirect('/email?connected=1&provider=yahoo');
    } catch (err) {
      console.error('[email/callback/yahoo] Error:', err);
      res.redirect('/email?error=server_error');
    }
  });

  // ── Yahoo inbox (IMAP + XOAUTH2)
  router.get('/yahoo/inbox', authenticateToken, async (req, res) => {
    try {
      const isPro = await checkProStatus(pool, req.user.id);
      if (!isPro) return res.status(403).json({ success: false, message: 'Pro required' });

      const { token, emailAddress } = await getValidYahooToken(pool, req.user.id);
      const messages = await yahooListMessages(emailAddress, token);

      res.json({ success: true, messages, next_page_token: null });
    } catch (err) {
      if (err.message === 'No connection found') {
        return res.status(404).json({ success: false, message: 'No Yahoo account connected' });
      }
      console.error('[email/yahoo/inbox]', err);
      res.status(500).json({ success: false, message: 'Failed to fetch Yahoo inbox' });
    }
  });

  return router;
};
