'use strict';
/**
 * Near-duplicate task titles. "Cancel MySubaru subscription" and "Cancel
 * MySubaru before it renews" are the same to-do; "Call mom" and "Call mom back"
 * are not. Two titles match when their meaningful words are the same set
 * (filler words dropped), so it only catches rewordings, never real variants.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'to', 'for', 'of', 'on', 'it', 'its', 'and',
  'before', 'renews', 'renew', 'renewal', 'subscription', 'subscriptions',
  'plan', 'membership', 'account', 'please', 'task', 'reminder', 'remember',
]);

function titleKey(title) {
  const words = String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w && !FILLER.has(w));
  return [...new Set(words)].sort().join(' ');
}

/** @returns the first open task whose title means the same thing, or null */
function findDuplicate(title, openTasks) {
  const key = titleKey(title);
  if (!key) return null;
  return (openTasks || []).find(t => titleKey(t.title) === key) || null;
}

module.exports = { titleKey, findDuplicate };
