/**
 * News Feed — RSS integration with bias scoring + de-polarization ranking
 *
 * Uses Node.js built-in https/http to fetch RSS feeds (no extra packages).
 * Parses XML with simple string extraction (RSS is predictably structured).
 * De-polarization: weighted ranking that actively balances the feed.
 *
 * Exports: { router, startRssCron }
 *   - router: Express router for /api/news routes
 *   - startRssCron: function to call once on server startup (setInterval 20min)
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { authenticateToken } = require('../middleware/auth');

const BIAS_WEIGHTS = {
  center: 1.0,
  lean_left: 0.8,
  lean_right: 0.8,
  left: 0.5,
  right: 0.5,
  unrated: 0.6
};

const BIAS_LABELS = {
  left: 'Left',
  lean_left: 'Lean Left',
  center: 'Center',
  lean_right: 'Lean Right',
  right: 'Right',
  unrated: 'Unrated'
};

const BIAS_COLORS = {
  left: 'bb-left',
  lean_left: 'bb-lean-left',
  center: 'bb-center',
  lean_right: 'bb-lean-right',
  right: 'bb-right',
  unrated: 'bb-unrated'
};

// ─────────────────────────────────────────────────────────────────────────────
// RSS FETCHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL with redirect following (max 3 hops).
 * Returns raw string body or throws.
 */
function fetchUrl(rawUrl, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error(`Bad URL: ${rawUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'FocusLedger-NewsBot/1.0 (RSS reader; contact@focusledger.net)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 10000
    };

    const req = lib.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        return fetchUrl(next, hops + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

/**
 * Extract text content from XML tag (first occurrence).
 * Handles CDATA. Returns '' if not found.
 */
function xmlText(xml, tag) {
  // Try CDATA first
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  let m = xml.match(cdataRe);
  if (m) return m[1].trim();

  // Regular text
  const textRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  m = xml.match(textRe);
  if (m) return m[1].replace(/<[^>]+>/g, '').trim(); // strip inner tags

  // Self-closing or attribute value (media:content url="...")
  return '';
}

/**
 * Extract an XML attribute value.
 */
function xmlAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Parse RSS/Atom XML and return array of article objects.
 */
function parseRss(xml, feedDomain) {
  const articles = [];

  // Split into <item> or <entry> blocks
  const itemRe = /<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  const items = xml.match(itemRe) || [];

  for (const item of items.slice(0, 30)) { // max 30 per feed
    const title = decode(xmlText(item, 'title'));
    const link = xmlText(item, 'link') || xmlAttr(item, 'link', 'href');
    if (!title || !link) continue;

    // Published date: try pubDate, then dc:date, then published, then updated
    const dateStr = xmlText(item, 'pubDate')
      || xmlText(item, 'dc:date')
      || xmlText(item, 'published')
      || xmlText(item, 'updated')
      || '';
    const published = dateStr ? new Date(dateStr) : new Date();
    const publishedAt = isNaN(published.getTime()) ? new Date() : published;

    // Image: try media:content, enclosure, or itunes:image
    let imageUrl = xmlAttr(item, 'media:content', 'url')
      || xmlAttr(item, 'enclosure', 'url')
      || xmlAttr(item, 'media:thumbnail', 'url')
      || '';
    // Only keep image if it looks like an image URL
    if (imageUrl && !/\.(jpg|jpeg|png|gif|webp)/i.test(imageUrl)) imageUrl = '';

    // Description: strip HTML tags, limit to 200 chars
    const rawDesc = xmlText(item, 'description') || xmlText(item, 'summary') || '';
    const description = decode(rawDesc.replace(/<[^>]+>/g, '').trim()).slice(0, 200);

    // Category
    const category = xmlText(item, 'category') || 'general';

    articles.push({
      headline: title.slice(0, 255),
      url: link.trim(),
      source_domain: feedDomain,
      image_url: imageUrl || null,
      description: description || null,
      published_at: publishedAt,
      category: normalizeCategory(category)
    });
  }

  return articles;
}

/** Normalize category string to one of our known categories */
function normalizeCategory(raw) {
  const s = (raw || '').toLowerCase();
  if (/polit|govern|congress|senate|elect|democr|republican/.test(s)) return 'politics';
  if (/tech|software|ai|cyber|data|internet|startup/.test(s)) return 'technology';
  if (/business|economy|market|financ|trade|invest|stock/.test(s)) return 'business';
  if (/health|medic|covid|hospital|drug|vaccine/.test(s)) return 'health';
  if (/science|climate|space|research|environment/.test(s)) return 'science';
  if (/sport|football|basketball|baseball|soccer|tennis|nfl|nba/.test(s)) return 'sports';
  if (/entertain|celebrity|movie|music|tv|film/.test(s)) return 'entertainment';
  return 'general';
}

/** Decode common HTML entities */
function decode(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '');
}

/** Extract domain from a URL */
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON JOB — fetch all feeds every 20 minutes
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllFeeds(pool) {
  // Deactivate known-failing feeds so they don't pollute logs with repeated errors.
  // Reuters (feeds.reuters.com): DNS not resolving on Render network.
  // AP News via rsshub.app: HTTP 403 blocked.
  // Deactivation is idempotent — safe to call every cron run.
  await pool.query(`
    UPDATE rss_feeds
    SET is_active = FALSE
    WHERE source_domain IN ('reuters.com', 'apnews.com')
      AND is_active = TRUE
  `).catch(() => { /* ignore — table may not exist on fresh deploy before migration runs */ });

  let feedsResult;
  try {
    feedsResult = await pool.query(
      'SELECT id, name, url, source_domain FROM rss_feeds WHERE is_active = TRUE'
    );
  } catch (err) {
    console.error('[News] DB error loading feeds:', err.message);
    return;
  }

  // Load bias map
  const biasMap = {};
  try {
    const biasResult = await pool.query('SELECT source_domain, bias_rating FROM news_source_bias');
    biasResult.rows.forEach(r => { biasMap[r.source_domain] = r.bias_rating; });
  } catch (err) {
    console.error('[News] DB error loading bias map:', err.message);
  }

  for (const feed of feedsResult.rows) {
    try {
      const xml = await fetchUrl(feed.url);
      const articles = parseRss(xml, feed.source_domain);

      for (const article of articles) {
        const domain = extractDomain(article.url) || feed.source_domain;
        const bias = biasMap[domain] || biasMap[feed.source_domain] || 'unrated';

        try {
          await pool.query(`
            INSERT INTO news_cache
              (source_feed_id, headline, url, source_name, source_domain, image_url, description, published_at, category, bias_rating, fetched_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (url) DO UPDATE SET
              headline = EXCLUDED.headline,
              description = EXCLUDED.description,
              image_url = COALESCE(EXCLUDED.image_url, news_cache.image_url),
              fetched_at = NOW()
          `, [
            feed.id,
            article.headline,
            article.url,
            feed.name,
            domain,
            article.image_url,
            article.description,
            article.published_at,
            article.category,
            bias
          ]);
        } catch (insertErr) {
          // Ignore duplicate/constraint errors quietly
          if (!insertErr.message.includes('duplicate') && !insertErr.message.includes('unique')) {
            console.error('[News] Insert error:', insertErr.message);
          }
        }
      }

      // Update feed last_fetched_at + clear last_error
      await pool.query(
        'UPDATE rss_feeds SET last_fetched_at = NOW(), last_error = NULL WHERE id = $1',
        [feed.id]
      );
      console.log(`[News] Fetched ${articles.length} articles from ${feed.name}`);
    } catch (err) {
      console.error(`[News] Failed to fetch ${feed.name}: ${err.message}`);
      try {
        await pool.query(
          'UPDATE rss_feeds SET last_error = $1, last_fetched_at = NOW() WHERE id = $2',
          [err.message.slice(0, 500), feed.id]
        );
      } catch { /* ignore */ }
    }

    // Brief pause between feeds to avoid overwhelming sources
    await new Promise(r => setTimeout(r, 300));
  }

  // Clean up articles older than 48 hours
  try {
    await pool.query(
      "DELETE FROM news_cache WHERE published_at < NOW() - INTERVAL '48 hours' AND fetched_at < NOW() - INTERVAL '48 hours'"
    );
  } catch (err) {
    console.error('[News] Cleanup error:', err.message);
  }
}

/**
 * Start the RSS cron on server boot.
 * Runs immediately, then every 20 minutes.
 */
function startRssCron(pool) {
  // Initial fetch after a short delay (let server fully start)
  setTimeout(() => {
    console.log('[News] Starting initial RSS fetch...');
    fetchAllFeeds(pool).catch(err => console.error('[News] Initial fetch error:', err.message));
  }, 5000);

  // Repeat every 20 minutes
  setInterval(() => {
    console.log('[News] Running scheduled RSS fetch...');
    fetchAllFeeds(pool).catch(err => console.error('[News] Scheduled fetch error:', err.message));
  }, 20 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// DE-POLARIZATION ALGORITHM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply de-polarization ranking to a list of articles.
 *
 * Algorithm:
 * 1. Score each article by recency × bias_weight
 * 2. Iteratively pick next article that improves overall balance
 * 3. Guarantee minimum 1 article per bias category (if available)
 * 4. Respect category filter
 */
function depolarize(articles, limit) {
  if (!articles.length) return [];

  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // Compute base scores
  const scored = articles.map(a => {
    const age = now - new Date(a.published_at).getTime();
    // Recency decay: 1.0 if < 6h, 0.7 if 6-12h, 0.4 if 12-24h, 0.2 if older
    const recency = age < 6 * 3600000 ? 1.0
      : age < TWELVE_HOURS ? 0.7
      : age < TWENTY_FOUR_HOURS ? 0.4
      : 0.2;
    const biasWeight = BIAS_WEIGHTS[a.bias_rating] || 0.6;
    return { ...a, _score: recency * biasWeight };
  });

  scored.sort((a, b) => b._score - a._score);

  // Count bias categories in candidate pool
  const poolCounts = {};
  scored.forEach(a => {
    poolCounts[a.bias_rating] = (poolCounts[a.bias_rating] || 0) + 1;
  });

  const result = [];
  const used = new Set();
  const feedCounts = { left: 0, lean_left: 0, center: 0, lean_right: 0, right: 0, unrated: 0 };

  // Phase 1: ensure minimum 1 from each available bias category
  const categories = ['center', 'lean_left', 'lean_right', 'left', 'right'];
  for (const bias of categories) {
    if (result.length >= limit) break;
    const candidate = scored.find(a => !used.has(a.id) && a.bias_rating === bias);
    if (candidate) {
      result.push(candidate);
      used.add(candidate.id);
      feedCounts[bias]++;
    }
  }

  // Phase 2: fill remaining slots, boosting underrepresented bias categories
  const idealPerCategory = limit / 5;
  while (result.length < limit && used.size < scored.length) {
    // Find the most underrepresented category
    const deficit = {};
    for (const bias of categories) {
      deficit[bias] = idealPerCategory - (feedCounts[bias] || 0);
    }
    const targetBias = categories.reduce((a, b) => deficit[a] > deficit[b] ? a : b);

    // Try to pick a high-scoring article from the target bias first
    let next = scored.find(a => !used.has(a.id) && a.bias_rating === targetBias);
    // Fall back to any article (sorted by score)
    if (!next) next = scored.find(a => !used.has(a.id));
    if (!next) break;

    result.push(next);
    used.add(next.id);
    feedCounts[next.bias_rating] = (feedCounts[next.bias_rating] || 0) + 1;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE FACTORY
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(pool) {
  const router = express.Router();

  /**
   * GET /api/news/headlines
   * Returns de-polarized headlines, supports ?category=&bias=&limit=&offset=&q=
   * Public endpoint — no auth required
   */
  router.get('/headlines', async (req, res) => {
    try {
      const category = req.query.category || '';
      const biasFilter = req.query.bias || '';
      const limitRaw = parseInt(req.query.limit) || 20;
      const limit = Math.min(limitRaw, 100);
      const offset = parseInt(req.query.offset) || 0;
      const search = (req.query.q || '').trim().slice(0, 100);
      // zone = req.query.zone — reserved for future local news filtering; currently both zones use national feed


      // For MVP: both global and local zones use national news
      let query = `
        SELECT id, headline, url, source_name, source_domain, image_url, description,
               published_at, category, bias_rating, fetched_at
        FROM news_cache
        WHERE published_at > NOW() - INTERVAL '48 hours'
      `;
      const params = [];

      if (category) {
        params.push(category);
        query += ` AND category = $${params.length}`;
      }
      if (biasFilter) {
        params.push(biasFilter);
        query += ` AND bias_rating = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        query += ` AND (LOWER(headline) LIKE LOWER($${params.length}) OR LOWER(source_name) LIKE LOWER($${params.length}))`;
      }
      query += ' ORDER BY published_at DESC LIMIT 200';

      const result = await pool.query(query, params);
      const articles = result.rows;

      // Apply de-polarization unless a specific bias is filtered
      const ranked = biasFilter ? articles.slice(offset, offset + limit) : depolarize(articles, limit + offset).slice(offset, offset + limit);

      // Compute balance stats for the ranked set
      const balanceCounts = { left: 0, lean_left: 0, center: 0, lean_right: 0, right: 0, unrated: 0 };
      ranked.forEach(a => {
        balanceCounts[a.bias_rating] = (balanceCounts[a.bias_rating] || 0) + 1;
      });

      res.json({
        success: true,
        articles: ranked.map(a => ({
          id: a.id,
          headline: a.headline,
          url: a.url,
          source: a.source_name,
          source_domain: a.source_domain,
          image_url: a.image_url,
          description: a.description,
          published_at: a.published_at,
          age: formatAge(a.published_at),
          category: a.category,
          bias_rating: a.bias_rating,
          bias_label: BIAS_LABELS[a.bias_rating] || 'Unrated',
          bias_class: BIAS_COLORS[a.bias_rating] || 'bb-unrated'
        })),
        balance: balanceCounts,
        total: articles.length
      });
    } catch (err) {
      console.error('[News] headlines error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load headlines' });
    }
  });

  /**
   * GET /api/news/balance
   * Returns distribution stats for the full cached feed
   */
  router.get('/balance', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT bias_rating, COUNT(*) as count
        FROM news_cache
        WHERE published_at > NOW() - INTERVAL '24 hours'
        GROUP BY bias_rating
      `);
      const counts = { left: 0, lean_left: 0, center: 0, lean_right: 0, right: 0, unrated: 0 };
      result.rows.forEach(r => {
        counts[r.bias_rating] = parseInt(r.count);
      });
      res.json({ success: true, balance: counts });
    } catch (err) {
      console.error('[News] balance error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load balance' });
    }
  });

  /**
   * GET /api/news/feeds
   * Returns active RSS feed list (for admin transparency)
   */
  router.get('/feeds', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, name, source_domain, category, is_active, last_fetched_at, last_error FROM rss_feeds ORDER BY name'
      );
      res.json({ success: true, feeds: result.rows });
    } catch {
      res.status(500).json({ success: false, message: 'Failed to load feeds' });
    }
  });

  /**
   * GET /api/news/location
   * Get user's saved location (requires auth)
   */
  router.get('/location', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT city, state_region, zip_code, country FROM users WHERE id = $1',
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.json({ success: true, location: null });
      }
      const row = result.rows[0];
      res.json({
        success: true,
        location: {
          city: row.city || null,
          state_region: row.state_region || null,
          zip_code: row.zip_code || null,
          country: row.country || 'US'
        }
      });
    } catch (err) {
      console.error('[News] get location error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to get location' });
    }
  });

  /**
   * POST /api/news/location
   * Set user location (requires auth)
   */
  router.post('/location', authenticateToken, async (req, res) => {
    try {
      const { city, state_region, zip_code, country } = req.body;
      await pool.query(`
        UPDATE users SET city = $1, state_region = $2, zip_code = $3, country = COALESCE($4, 'US')
        WHERE id = $5
      `, [city || null, state_region || null, zip_code || null, country || 'US', req.user.id]);
      res.json({ success: true, message: 'Location saved' });
    } catch (err) {
      console.error('[News] location error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save location' });
    }
  });

  return router;
};

// Export startRssCron separately so server.js can call it
module.exports.startRssCron = startRssCron;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatAge(date) {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d`;
}
