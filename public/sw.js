/**
 * FocusLedger Service Worker
 * - Network-first for JS/CSS (guarantees fresh app logic on every load)
 * - Cache-first for images, fonts, icons (rarely change, large payloads)
 * - Network-first for HTML navigation with offline fallback
 * - API calls pass through unintercepted
 * - Push notification handler for deadline nudges
 *
 * WHY network-first for JS/CSS: cache-first caused 4 deploy failures where
 * returning visitors saw stale cached JS indefinitely. Version-bump approach
 * (fl-v20→v21) didn't work because browser HTTP cache could hold stale sw.js.
 * Network-first eliminates the problem: fresh code when online, cached fallback
 * when offline. The ~50ms latency cost is invisible on modern connections.
 */

const CACHE_VERSION = 'fl-v36';
const OFFLINE_URL = '/offline.html';

// Assets to precache on install (app shell)
const PRECACHE_URLS = [
  '/',
  '/app',
  '/home',       // Morning nudge notification tap target
  '/app/buddy',  // Accountabilibuddy check-in page
  '/money',      // Money page — was missing, caused stale cache on offline fallback
  '/buddy',      // Buddy direct route
  '/portal',
  '/login',
  '/signup',
  '/pricing',
  '/settings',
  '/ideas',
  '/values',
  '/journal',
  '/admin/stats',
  '/css/science.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  OFFLINE_URL,
];

// File extensions that get network-first (app logic — must be fresh)
const NETWORK_FIRST_EXT = /\.(js|css)(\?.*)?$/i;

// ─── Install: precache shell ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] Failed to precache:', url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate: clean old caches, notify clients ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    )
    .then(() => self.clients.claim())
    .then(() => {
      // Tell all open tabs a new SW version activated so they can reload
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

// ─── Fetch: routing logic ──────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin + Google Fonts
  if (url.origin !== self.location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com')) {
    return;
  }

  // Skip non-GET
  if (request.method !== 'GET') return;

  // API calls → let the browser handle directly (no SW interception).
  // Previously used networkFirst which caused fetch hangs on iOS Safari.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigation (HTML pages) → Network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // JS and CSS → Network-first (guarantees fresh app logic after deploys)
  if (NETWORK_FIRST_EXT.test(url.pathname)) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  // Everything else (images, fonts, icons, manifest) → Cache-first
  event.respondWith(cacheFirst(request));
});

// ─── Strategy: Network-first for JS/CSS ─────────────────────────────────────
// WHY: cache-first for JS caused 4 consecutive deploy failures. Fresh code
// on every online load is worth the negligible latency cost.
async function networkFirstAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline — fall back to cached version
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// ─── Strategy: Cache-first (images, fonts, icons) ───────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// ─── Navigation handler with offline fallback ─────────────────────────────
// WHY cache: 'no-store': the SW's network-first strategy relies on fetch()
// hitting the origin server, but fetch() inside a SW still consults the
// browser HTTP cache first. If the server sent a strong ETag or
// Cache-Control: public, the HTTP cache can return a stale 200 before the
// SW ever reaches the origin — defeating network-first. 'no-store' forces
// fetch to bypass the HTTP cache entirely so every navigation gets a
// guaranteed-fresh response from the server.
async function navigationHandler(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Try cached version first
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fall back to offline page
    const offlinePage = await caches.match(OFFLINE_URL);
    if (offlinePage) return offlinePage;

    return new Response('<h1>You are offline</h1>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

// ─── Push Notifications ────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'FocusLedger', body: 'You have a task due soon.', url: '/app' };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  // WHY tag-based dedup: browser replaces existing notification with same tag
  // instead of stacking duplicates. renotify=false means no re-alert sound/vibration
  // when the notification is silently replaced. Server-side dedup is the primary
  // guard; this is the browser-level safety net.
  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'focusledger-nudge',
    renotify: false,
    data: { url: data.url || '/app' },
    actions: [
      { action: 'open', title: 'View Tasks' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    requireInteraction: false
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ─── Notification click handler ────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/app';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ─── Background sync (future: retry failed expense saves) ─────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-pending-actions') {
    event.waitUntil(syncPendingActions());
  }
});

async function syncPendingActions() {
  // Placeholder for future offline-queue sync
  console.log('[SW] Background sync triggered (no-op for now)');
}
