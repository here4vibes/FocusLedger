/**
 * Lightweight natural language date/time parser for Quick-Add.
 * Covers: today, tomorrow, yesterday, next N days, day names,
 * relative times (3pm, 5:30pm, at 3), and combinations.
 * Returns { date: 'YYYY-MM-DD', time: 'HH:MM' } or null.
 */

/** @type {Record<string, number>} 0=Sun */
const DAY_MAP = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wed: 3, wednesday: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

function today() { const d = new Date(); d.setHours(0,0,0,0); return d; }

function getNextDay(target) {
  const t = today();
  const cur = t.getDay();
  const diff = ((target - cur) + 7) % 7;
  if (diff === 0) return null; // "next monday" means future — handled by callers
  t.setDate(t.getDate() + diff);
  return t;
}

function parseTimePart(tok) {
  // "3pm", "3:00pm", "17", "5:30", "noon", "midnight"
  tok = tok.toLowerCase().replace(/\bat\b/g, '').trim();
  if (tok === 'noon' || tok === 'midday') return { hour: 12, minute: 0 };
  if (tok === 'midnight') return { hour: 0, minute: 0 };

  const m = tok.match(/^(\b(?:[0-9]|1[0-2])\b)(:([0-5][0-9]))?\\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = m[3] ? parseInt(m[3]) : 0;
  const ap = (m[4] || '').toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 12) h += 12; // "3" alone → 3pm unless less than 12 on ambiguity, defaulting to afternoon
  return { hour: h, minute: min };
}

function parseDatePart(text) {
  text = text.toLowerCase().trim();

  // "tomorrow"
  if (/^tomorrow(\b|$)/i.test(text)) {
    const d = new Date(today()); d.setDate(d.getDate() + 1);
    return { date: fmt(d), hasNext: false };
  }
  // "today"
  if (/^today(\b|$)/i.test(text)) {
    return { date: fmt(today()), hasNext: false };
  }

  // "next monday" / "next fri" / "next tuesday"
  const nextMatch = text.match(/^next\b.*?\b(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
  if (nextMatch) {
    const target = DAY_MAP[nextMatch[1].toLowerCase()];
    if (target !== undefined) {
      const t = today();
      t.setDate(t.getDate() + 7 + ((target - t.getDay() + 7) % 7));
      return { date: fmt(t), hasNext: false };
    }
  }

  // "in 3 days" / "in a week"
  const inMatch = text.match(/^in\b.*?(\b[a-z]+\b)(?:\b|$)/i);
  if (inMatch) {
    const unit = inMatch[1].toLowerCase();
    if (/^(day|days|d)$/.test(unit)) {
      const m = text.match(/^in\b.*?(\b[0-9]+\b)/i);
      const n = m ? parseInt(m[1]) : 1;
      const d = new Date(today()); d.setDate(d.getDate() + n);
      return { date: fmt(d), hasNext: false };
    }
    if (/^(week|weeks|w)$/.test(unit)) {
      const m = text.match(/^in\b.*?(\b[0-9]+)/i);
      const n = m ? parseInt(m[1]) : 1;
      const d = new Date(today()); d.setDate(d.getDate() + n * 7);
      return { date: fmt(d), hasNext: false };
    }
  }

  // bare day name: "monday", "friday"
  const dayMatch = text.match(/^(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (dayMatch) {
    const target = DAY_MAP[dayMatch[1].toLowerCase()];
    if (target !== undefined) {
      const t = today();
      const diff = ((target - t.getDay() + 7) % 7);
      // If it's the same day and it's already passed, next week
      const d = diff === 0 ? null : null; // will be handled as "next week"
      t.setDate(t.getDate() + diff);
      return { date: fmt(t), hasNext: diff === 0 };
    }
  }

  return null;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Parse natural language from task title.
 * Returns { parsed: { date: 'YYYY-MM-DD'|null, time: 'HH:MM'|null }, remaining: 'clean title' }
 */
function parseNaturalLanguage(text) {
  let timeStr = null;
  let clean = text;

  // Try "at 5pm" style first — "at 3pm", "at 5:30pm", "at 3"
  const atMatch = text.match(/\bat\s+([0-9]{1,2}(?:[0-5][0-9])?(?:pm|am)?)/i);
  if (atMatch) {
    timeStr = atMatch[1].toLowerCase();
    clean = text.replace(atMatch[0], '').trim();
  } else {
    // Try standalone time: "5pm", "3:30pm"
    const standalone = text.match(/\b([0-9]{1,2}):([0-5][0-9])\s*(pm|am)/i);
    if (standalone) {
      const h = parseInt(standalone[1]);
      const m = parseInt(standalone[2]);
      const ap = (standalone[3] || '').toLowerCase();
      let hour = h;
      if (ap === 'pm' && h !== 12) hour += 12;
      if (ap === 'am' && h === 12) hour = 0;
      if (!ap && h < 12) hour += 12; // default afternoon
      timeStr = `${String(hour).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      clean = text.replace(standalone[0], '').trim();
    } else {
      // Try just number + am/pm: "3pm", "5pm"
      const numMatch = text.match(/\bat\s+([0-9]{1,2})\b(?::([0-5][0-9]))?\s*(pm|am)/i);
      if (numMatch) {
        let h = parseInt(numMatch[1]);
        const m = numMatch[2] ? parseInt(numMatch[2]) : 0;
        const ap = (numMatch[3] || '').toLowerCase();
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (!ap && h < 12) h += 12;
        timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        clean = text.replace(numMatch[0], '').trim();
      } else {
        // Try just "3pm" style without "at"
        const simpleMatch = text.match(/\b([1-9]|1[0-2])\s*(pm|am)\b/i);
        if (simpleMatch) {
          let h = parseInt(simpleMatch[1]);
          const ap = simpleMatch[2].toLowerCase();
          if (ap === 'pm' && h !== 12) h += 12;
          if (ap === 'am' && h === 12) h = 0;
          timeStr = `${String(h).padStart(2,'0')}:00`;
          clean = text.replace(simpleMatch[0], '').trim();
        }
      }
    }
  }

  // Parse date from remaining text
  let dateResult = parseDatePart(clean);

  // If day name is today already passed, move to next week
  if (dateResult && dateResult.hasNext) {
    const t = today();
    t.setDate(t.getDate() + ((DAY_MAP[clean.match(/^(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1].toLowerCase()] - t.getDay() + 7) % 7 || 7));
    dateResult = { date: fmt(t), hasNext: false };
  }

  // Remove date phrases from clean title
  const datePhrasePatterns = [
    /\btomorrow\b/gi,
    /\btoday\b/gi,
    /\bnext\s+\b(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    /\b(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    /\bin\s+[0-9]+\s+(days?|weeks?)\b/gi,
  ];
  for (const pat of datePhrasePatterns) {
    clean = clean.replace(pat, '').trim();
  }

  // Parse and strip recurrence phrase from title
  const recurrence = parseRecurrence(clean);
  if (recurrence) {
    clean = clean.replace(new RegExp(recurrence.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/\s{2,}/g, ' ').trim();
  }

  return {
    parsed: {
      date: dateResult?.date || null,
      time: timeStr || null,
      recurrence: recurrence,
    },
    remaining: clean,
  };
}

/**
 * Detect recurrence patterns in task title text.
 * Returns { type, day, label, phrase } or null.
 *   type: 'daily' | 'weekdays' | 'weekly' | 'monthly'
 *   day:  0-6 (JS day-of-week) for weekly, null otherwise
 *   label: human-readable chip text
 *   phrase: the matched text to strip from the title
 */
const RECUR_DAY_MAP = { sunday:0, sun:0, monday:1, mon:1, tuesday:2, tue:2, wednesday:3, wed:3, thursday:4, thu:4, friday:5, fri:5, saturday:6, sat:6 };
const RECUR_DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function parseRecurrence(text) {
  const t = text.toLowerCase();

  // "every day" / "daily"
  const dailyM = t.match(/\b(every\s+day|daily)\b/);
  if (dailyM) return { type: 'daily', day: null, label: '🔄 Daily', phrase: dailyM[0] };

  // "every weekday" / "weekdays" / "each weekday"
  const wdM = t.match(/\b(every\s+weekday|each\s+weekday|weekdays)\b/);
  if (wdM) return { type: 'weekdays', day: null, label: '🔄 Weekdays', phrase: wdM[0] };

  // "every monday" / "each friday" / "mondays" / "tuesdays" etc.
  const dayNamePat = /\b(?:every|each)\s+(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;
  const dayPluralPat = /\b(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/;
  const everyDayM = t.match(dayNamePat);
  if (everyDayM) {
    const key = everyDayM[1].toLowerCase();
    const dayNum = RECUR_DAY_MAP[key];
    if (dayNum !== undefined) return { type: 'weekly', day: dayNum, label: '🔄 Every ' + RECUR_DAY_NAMES[dayNum], phrase: everyDayM[0] };
  }
  const pluralDayM = t.match(dayPluralPat);
  if (pluralDayM) {
    const key = pluralDayM[1].toLowerCase().replace(/s$/, '');
    const dayNum = RECUR_DAY_MAP[key];
    if (dayNum !== undefined) return { type: 'weekly', day: dayNum, label: '🔄 Every ' + RECUR_DAY_NAMES[dayNum], phrase: pluralDayM[0] };
  }

  // "every week" / "weekly"
  const weekM = t.match(/\b(every\s+week|weekly)\b/);
  if (weekM) return { type: 'weekly', day: null, label: '🔄 Weekly', phrase: weekM[0] };

  // "every month" / "monthly" / "once a month"
  const monthM = t.match(/\b(every\s+month|monthly|once\s+a\s+month)\b/);
  if (monthM) return { type: 'monthly', day: null, label: '🔄 Monthly', phrase: monthM[0] };

  return null;
}

/**
 * Get a human-readable chip label for a parsed date+time.
 */
function chipLabel(parsed) {
  if (!parsed.date && !parsed.time) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const tmrw = new Date(today); tmrw.setDate(tmrw.getDate() + 1);

  const d = parsed.date ? new Date(parsed.date + 'T12:00:00') : null;
  const parts = [];

  if (d) {
    const dDay = d.setHours(0,0,0,0);
    if (dDay === tmrw.setHours(0,0,0,0)) parts.push('Tomorrow');
    else if (dDay === today.setHours(0,0,0,0)) parts.push('Today');
    else parts.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
  }

  if (parsed.time) {
    const [h, m] = parsed.time.split(':').map(Number);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    parts.push(`${h12}:${String(m).padStart(2,'0')}${ampm}`);
  }

  return parts.join(' ');
}