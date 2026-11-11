// lib/plain-add-task.js — read a literal "Add a task: <title>" without the model.
//
// Buddy normally lets the model decide what a message means. When the model
// can't be reached, the one request a brand-new user is told to type (Home's
// first-visit prompt and its "Add a task of my own" chip) must still work, so
// this recognises only that explicit form and returns the title as typed.
// Anything looser ("can you add…", "remind me…") stays with the model.

const PLAIN_ADD = /^\s*(?:please\s+)?add\s+(?:(?:a|the|this|new|another)\s+){0,2}task\s*[:\-–—]\s*(.+?)\s*$/i;

function parsePlainAddTask(message) {
  if (typeof message !== 'string') return null;
  if (message.indexOf('\n') !== -1) return null;
  const m = PLAIN_ADD.exec(message);
  if (!m) return null;
  const title = m[1].replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (title.length < 2 || title.length > 200) return null;
  return title;
}

module.exports = { parsePlainAddTask };
