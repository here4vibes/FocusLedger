'use strict';
// lib/task-cap-reply.js — what Buddy says when the free plan's task cap stops
// it adding a task. Owns the wording only; the count lives in db/task-cap.js
// and the check in middleware/proUtils.js (taskSlotsLeft).
//
// The agent turn is single-shot: the model writes its reply before any tool
// runs, so it may say "added" for a task the cap then refused. The routes
// replace that reply with this text (the truth rule: only claim what a tool
// receipt confirms). Inside the iOS app nothing may point to a purchase, so
// `native` drops the Autopilot sentence (see lib/native-app.js).

const { FREE_TASK_LIMIT } = require('../db/task-cap');

const TASK_LIMIT_CODE = 'TASK_LIMIT_REACHED';

const quote = (titles) => titles.map((t) => `“${t}”`).join(', ');

/**
 * @param {object}   [o]
 * @param {boolean}  [o.native]  request came from the iOS app: no plan mention
 * @param {number}   [o.added]   tasks that did get added in the same turn
 * @param {string[]} [o.skipped] titles that were not added
 * @returns {string}
 */
function taskCapReply({ native = false, added = 0, skipped = [] } = {}) {
  const what = skipped.length ? quote(skipped.slice(0, 5)) + (skipped.length > 5 ? ` and ${skipped.length - 5} more` : '') : 'that';
  const first = added > 0
    ? `I added what fit, and then your list was full, so I didn’t add ${what}.`
    : `Your list is full, so I didn’t add ${what}.`;
  const parts = [
    first,
    `The free plan holds ${FREE_TASK_LIMIT} active tasks of your own (routine tasks don’t count).`,
    'Finish or remove one and tell me again, and I’ll add it.',
  ];
  if (!native) parts.push('Autopilot takes the limit off, if you’d rather have the room.');
  return parts.join(' ');
}

/** The short line shown on the "Not done" receipt chip. */
function taskCapReceipt(title) {
  return `Didn’t add “${title}”: your list is full`;
}

module.exports = { TASK_LIMIT_CODE, taskCapReply, taskCapReceipt };
