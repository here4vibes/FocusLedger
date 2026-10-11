'use strict';
/**
 * Where to cancel common subscriptions: the merchant's own cancel or account
 * page. Only well-known, stable URLs; anything not listed gets no link (the
 * cancel task + "Show me how" still cover it). App-store billing can only be
 * cancelled in the store, so those deep-link to the store's subscriptions page.
 * Matched against the merchant name as it appears in bank data.
 */
const CANCEL_LINKS = [
  { pattern: /netflix/i,                       label: 'Netflix',        url: 'https://www.netflix.com/cancelplan' },
  { pattern: /spotify/i,                       label: 'Spotify',        url: 'https://www.spotify.com/account/subscription/' },
  { pattern: /hulu/i,                          label: 'Hulu',           url: 'https://secure.hulu.com/account' },
  { pattern: /disney\s*(\+|plus)/i,            label: 'Disney+',        url: 'https://www.disneyplus.com/account' },
  { pattern: /youtube\s*(premium|tv|music)?/i, label: 'YouTube',        url: 'https://www.youtube.com/paid_memberships' },
  { pattern: /paramount/i,                     label: 'Paramount+',     url: 'https://www.paramountplus.com/account/' },
  { pattern: /amazon\s*(prime|video)|prime\s*video/i, label: 'Amazon Prime', url: 'https://www.amazon.com/mc' },
  { pattern: /adobe/i,                         label: 'Adobe',          url: 'https://account.adobe.com/plans' },
  { pattern: /microsoft|xbox/i,                label: 'Microsoft',      url: 'https://account.microsoft.com/services' },
  { pattern: /dropbox/i,                       label: 'Dropbox',        url: 'https://www.dropbox.com/account/plan' },
  // App-store billing: the store is the only place to cancel.
  { pattern: /apple\.com\/bill|itunes|apple\s*(tv|music|one|arcade)|icloud/i, label: 'Apple', url: 'https://apps.apple.com/account/subscriptions', store: true },
  { pattern: /google\s*\*?\s*(play|one|storage)/i, label: 'Google Play', url: 'https://play.google.com/store/account/subscriptions', store: true },
];

/** @returns {{ url: string, label: string, store: boolean } | null} */
function cancelLinkFor(name) {
  const hit = CANCEL_LINKS.find(l => l.pattern.test(name || ''));
  return hit ? { url: hit.url, label: hit.label, store: !!hit.store } : null;
}

module.exports = { cancelLinkFor, CANCEL_LINKS };
