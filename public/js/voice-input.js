/**
 * FocusLedger Voice Input — v2
 * Browser-native speech recognition via Web Speech API.
 * No external API cost. Supported on Chrome, Edge, Safari.
 *
 * v2 additions:
 *   - Recurrence parsing: daily/weekly/biweekly/monthly/quarterly/annually + natural variants
 *   - Extended date patterns: absolute month dates, "end of month", "next week", etc.
 *   - Value alignment engine: fuzzy keyword matching against caller-supplied user values
 *   - NLP.parse() public API for typed-text parsing (same pipeline as voice)
 *
 * Usage:
 *   VoiceInput.attach({
 *     container: element,         // where to inject the mic button
 *     targetInput: inputEl,       // default input to fill on ambiguous transcript
 *     context: 'auto',            // 'task' | 'expense' | 'journal' | 'auto'
 *     userValues: [],             // array of { id, value_name } for value matching
 *     onResult: fn,               // optional (transcript, intent, data)
 *     onTaskCreate: fn,           // optional ({ title, dueDate, recurrence, matchedValue })
 *     onExpenseLog: fn,           // optional ({ amount, description, merchant, recurrence, matchedValue })
 *     onCompleteTask: fn,         // optional (taskTitle)
 *   });
 *
 *   VoiceInput.NLP.parse(text, userValues) → { intent, title, dueDate, recurrence, matchedValue, ... }
 */

(function (global) {
  'use strict';

  // ─── Number words ─────────────────────────────────────────────────────────

  var WORD_TO_NUM = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100
  };

  // ─── Month name → number ──────────────────────────────────────────────────

  var MONTH_MAP = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
    april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12
  };

  // Ordinal suffixes for absolute dates ("15th", "3rd")
  var ORD_RE = /(\d+)(?:st|nd|rd|th)/i;

  // ─── Due date patterns ────────────────────────────────────────────────────

  function fmtDate(d) {
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + day;
  }

  function nextWeekday(name, forceNext) {
    var days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    var target = days.indexOf(name.toLowerCase());
    var today = new Date();
    var diff = target - today.getDay();
    if (diff <= 0 || forceNext) diff += 7;
    var d = new Date(today);
    d.setDate(d.getDate() + diff);
    return fmtDate(d);
  }

  // Returns null or a YYYY-MM-DD string
  function extractDueDate(text) {
    var t = text;

    // "today"
    if (/\btoday\b/i.test(t)) return fmtDate(new Date());

    // "tomorrow"
    if (/\btomorrow\b/i.test(t)) {
      var d = new Date(); d.setDate(d.getDate() + 1); return fmtDate(d);
    }

    // "next week"
    if (/\bnext\s+week\b/i.test(t)) {
      var d = new Date(); d.setDate(d.getDate() + 7); return fmtDate(d);
    }

    // "next <weekday>"
    var nwd = t.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (nwd) return nextWeekday(nwd[1], true);

    // "<weekday>" (nearest future)
    var wd = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (wd) return nextWeekday(wd[1], false);

    // "in N days/weeks"
    var ind = t.match(/\bin\s+(\d+|[a-z]+)\s+(days?|weeks?)\b/i);
    if (ind) {
      var n = parseInt(ind[1], 10);
      if (isNaN(n)) n = WORD_TO_NUM[ind[1].toLowerCase()] || 0;
      var d = new Date();
      if (/week/i.test(ind[2])) n *= 7;
      d.setDate(d.getDate() + n);
      return fmtDate(d);
    }

    // "end of month" / "end of the month"
    if (/\bend\s+of\s+(?:the\s+)?month\b/i.test(t)) {
      var now = new Date();
      var d = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day
      return fmtDate(d);
    }

    // "end of [month name]"
    var eom = t.match(/\bend\s+of\s+([a-z]+)\b/i);
    if (eom) {
      var mnum = MONTH_MAP[eom[1].toLowerCase()];
      if (mnum) {
        var yr = new Date().getFullYear();
        var d = new Date(yr, mnum, 0); // last day of that month
        if (d < new Date()) d = new Date(yr + 1, mnum, 0);
        return fmtDate(d);
      }
    }

    // "May 15th" / "15th of May" / "May 15" / "June 1st"
    var mdate1 = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d+)(?:st|nd|rd|th)?\b/i);
    if (mdate1) {
      var mnum = MONTH_MAP[mdate1[1].toLowerCase()];
      var day = parseInt(mdate1[2], 10);
      if (mnum && day) {
        var yr = new Date().getFullYear();
        var d = new Date(yr, mnum - 1, day);
        if (d < new Date()) d = new Date(yr + 1, mnum - 1, day);
        return fmtDate(d);
      }
    }

    // "15th of May" / "3rd of November"
    var mdate2 = t.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i);
    if (mdate2) {
      var day = parseInt(mdate2[1], 10);
      var mnum = MONTH_MAP[mdate2[2].toLowerCase()];
      if (mnum && day) {
        var yr = new Date().getFullYear();
        var d = new Date(yr, mnum - 1, day);
        if (d < new Date()) d = new Date(yr + 1, mnum - 1, day);
        return fmtDate(d);
      }
    }

    // "first of the month" → 1st of next month
    if (/\bfirst\s+of\s+(?:the\s+)?month\b/i.test(t)) {
      var now = new Date();
      var d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return fmtDate(d);
    }

    return null;
  }

  // ─── Recurrence parsing ───────────────────────────────────────────────────
  // Returns one of: daily | weekly | biweekly | monthly | quarterly | annually | null

  function extractRecurrence(text) {
    var t = text.toLowerCase();

    // Daily
    if (/\b(?:every\s+day|daily|each\s+day)\b/.test(t)) return 'daily';

    // Biweekly / every 2 weeks / every other week
    if (/\b(?:every\s+(?:other|2nd|two)\s+week|biweekly|bi-weekly|every\s+2\s+weeks?|twice\s+a\s+month)\b/.test(t)) return 'biweekly';

    // Quarterly
    if (/\b(?:quarterly|every\s+(?:3|three)\s+months?|every\s+quarter)\b/.test(t)) return 'quarterly';

    // Annually / yearly / once a year
    if (/\b(?:annually|yearly|every\s+year|once\s+a\s+year)\b/.test(t)) return 'annually';

    // Monthly
    if (/\b(?:every\s+month|monthly|each\s+month|once\s+a\s+month)\b/.test(t)) return 'monthly';

    // Weekly — catches "every week", "every Sunday", "every [weekday]", "weekly"
    if (/\b(?:every\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly|each\s+week)\b/.test(t)) return 'weekly';

    return null;
  }

  // ─── Value alignment matching ─────────────────────────────────────────────
  // userValues: array of { id, value_name }
  // Returns { value, score } or null

  // Keyword hints for common value categories — expands recall
  var VALUE_KEYWORD_HINTS = {
    health:    ['gym', 'workout', 'exercise', 'run', 'doctor', 'dentist', 'medicine', 'yoga', 'sleep', 'diet', 'fitness', 'weight', 'mental', 'therapy', 'vitamins', 'walk', 'bike', 'swim', 'nutrition'],
    family:    ['mom', 'dad', 'parent', 'child', 'kids', 'son', 'daughter', 'wife', 'husband', 'brother', 'sister', 'grandma', 'grandpa', 'family', 'relatives'],
    career:    ['resume', 'interview', 'job', 'work', 'meeting', 'project', 'boss', 'colleague', 'promotion', 'salary', 'linkedin', 'skill', 'course', 'training', 'deadline', 'client', 'email', 'presentation'],
    finance:   ['pay', 'bill', 'rent', 'mortgage', 'bank', 'invest', 'save', 'budget', 'tax', 'insurance', 'credit', 'loan', 'debt', 'expense', 'money', 'financial', 'payment', 'subscription', 'invoice'],
    education: ['study', 'class', 'school', 'college', 'university', 'homework', 'exam', 'test', 'course', 'learn', 'read', 'book', 'tutor', 'degree', 'graduate'],
    social:    ['friend', 'party', 'event', 'social', 'date', 'hang', 'call', 'text', 'meet', 'dinner', 'lunch', 'coffee', 'catch up'],
    travel:    ['trip', 'flight', 'hotel', 'pack', 'visa', 'passport', 'travel', 'vacation', 'airbnb', 'booking', 'reservation'],
    creativity:['write', 'paint', 'draw', 'music', 'create', 'design', 'art', 'photo', 'blog', 'podcast', 'video', 'craft', 'build', 'creative'],
    spiritual: ['meditate', 'pray', 'church', 'faith', 'spiritual', 'mindful', 'journal', 'gratitude', 'reflect'],
    wellbeing: ['rest', 'relax', 'self-care', 'nap', 'bath', 'breathe', 'stress', 'anxiety', 'hobby', 'fun', 'joy'],
  };

  function matchValueFromText(text, userValues) {
    if (!userValues || !userValues.length) return null;
    var t = text.toLowerCase();
    var words = t.split(/\W+/).filter(function(w) { return w.length > 2; });

    var best = null;
    var bestScore = 0;

    userValues.forEach(function(v) {
      if (!v.value_name) return;
      var name = v.value_name.toLowerCase();
      var score = 0;

      // Direct name match in text (highest weight)
      if (t.indexOf(name) !== -1) score += 3;

      // Word-by-word name overlap
      var nameWords = name.split(/\W+/).filter(function(w) { return w.length > 2; });
      nameWords.forEach(function(nw) {
        if (words.indexOf(nw) !== -1) score += 2;
      });

      // Keyword hint matching — find which hint category matches the value name
      Object.keys(VALUE_KEYWORD_HINTS).forEach(function(cat) {
        // Does the value name relate to this category?
        if (name.indexOf(cat) !== -1 || cat.indexOf(name) !== -1 || name.length > 3 && cat.slice(0, 4) === name.slice(0, 4)) {
          // Check if any hints appear in text
          VALUE_KEYWORD_HINTS[cat].forEach(function(hint) {
            if (t.indexOf(hint) !== -1) score += 1;
          });
        }
      });

      // Also: check hints directly against value name keywords
      Object.keys(VALUE_KEYWORD_HINTS).forEach(function(cat) {
        if (VALUE_KEYWORD_HINTS[cat].indexOf(name) !== -1) {
          VALUE_KEYWORD_HINTS[cat].forEach(function(hint) {
            if (t.indexOf(hint) !== -1) score += 1;
          });
        }
      });

      if (score > bestScore) {
        bestScore = score;
        best = { value: v, score: score };
      }
    });

    // Minimum threshold: score must be >= 1 to suggest
    return bestScore >= 1 ? best : null;
  }

  // ─── Amount / merchant extraction ─────────────────────────────────────────

  function normaliseNumbers(text) {
    return text.replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi,
      function (m) { return WORD_TO_NUM[m.toLowerCase()] != null ? WORD_TO_NUM[m.toLowerCase()] : m; }
    );
  }

  function extractAmount(text) {
    var n = normaliseNumbers(text);
    var m;
    m = n.match(/\$(\d+(?:\.\d{1,2})?)/);
    if (m) return parseFloat(m[1]);
    m = n.match(/(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)/i);
    if (m) return parseFloat(m[1]);
    m = n.match(/(?:spent|paid|pay|cost|bought|charged|spend)\s+(?:about\s+)?(\d+(?:\.\d{1,2})?)/i);
    if (m) return parseFloat(m[1]);
    return null;
  }

  function extractMerchant(text) {
    var m = text.match(/\bat\s+([A-Z][a-zA-Z0-9\s&'.\-]{1,30}?)(?:\s+(?:for|on|yesterday|today|this|last|a\s)|\.|,|$)/i);
    if (m) return m[1].trim();
    m = text.match(/\bfrom\s+([A-Z][a-zA-Z0-9\s&'.\-]{1,25}?)(?:\s+(?:for|on|yesterday|today|this)|\.|,|$)/i);
    if (m) return m[1].trim();
    return null;
  }

  // ─── Core intent parser ───────────────────────────────────────────────────

  function parseIntent(transcript, userValues) {
    var t = transcript.trim();
    if (!t) return { intent: 'ambiguous', text: t };

    var dueDate    = extractDueDate(t);
    var recurrence = extractRecurrence(t);
    var valueMatch = matchValueFromText(t, userValues || []);

    // ── Expense ─────────────────────────────────────────────────────────────
    var amount = extractAmount(t);
    var hasExpenseVerb = /\b(?:spent|paid|spend|pay|bought|charged|purchase|cost)\b/i.test(t);
    if (amount !== null && (hasExpenseVerb || /\$/.test(t))) {
      var merchant = extractMerchant(t);
      var desc = merchant || t
        .replace(/(?:i\s+)?(?:spent|paid|bought|charged|purchased)\s+(?:about\s+)?\$?\d+(?:\.\d+)?\s*(?:dollars?|bucks?)?\s*/i, '')
        .replace(/\bat\s+.*$/, '')
        .trim() || t;
      return {
        intent: 'expense',
        amount: amount,
        description: desc,
        merchant: merchant,
        recurrence: recurrence,
        matchedValue: valueMatch ? valueMatch.value : null,
        text: t
      };
    }

    // ── Task completion ──────────────────────────────────────────────────────
    var completeRe = /(?:i(?:'ve)?\s+)?(?:finished|completed|done with|done|marked?\s+(?:as\s+)?(?:complete|done)|checked\s+off)\s+(.+)/i;
    var cm = t.match(completeRe);
    if (cm) return { intent: 'complete-task', taskTitle: cm[1].trim(), text: t };

    // ── Task creation ────────────────────────────────────────────────────────
    var taskRe = /(?:i\s+)?(?:need\s+to|have\s+to|must|should|gotta|remind\s+me\s+to|don't\s+forget\s+to|add\s+(?:a\s+)?task[:\s]+|create\s+(?:a\s+)?task[:\s]+|new\s+task[:\s]+)\s+(.+)/i;
    var tm = t.match(taskRe);
    if (tm) {
      var rawTitle = tm[1]
        .replace(/\s+(?:by|before|due|on)\s+.*/i, '')
        .replace(/\bevery\s+\w+\b.*$/i, '')
        .trim();
      return {
        intent: 'task',
        title: rawTitle,
        dueDate: dueDate,
        recurrence: recurrence,
        matchedValue: valueMatch ? valueMatch.value : null,
        text: t
      };
    }

    // ── Journal hint ─────────────────────────────────────────────────────────
    if (/\b(?:today\s+(?:was|i|felt|we)|this\s+(?:morning|evening|afternoon|week)\s+i|journal|rough\s+day|good\s+day|had\s+a)\b/i.test(t)) {
      return { intent: 'journal', text: t };
    }

    // ── Ambiguous — still extract useful signals ──────────────────────────────
    return {
      intent: 'ambiguous',
      dueDate: dueDate,
      recurrence: recurrence,
      matchedValue: valueMatch ? valueMatch.value : null,
      text: t
    };
  }

  // Friendly labels for recurrence values
  function recurrenceLabel(r) {
    return {
      daily: 'daily',
      weekly: 'weekly',
      biweekly: 'every 2 weeks',
      monthly: 'monthly',
      quarterly: 'quarterly',
      annually: 'annually'
    }[r] || r;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  var STYLE_ID = 'fl-voice-input-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      // Mic button
      '.fl-voice-btn{display:inline-flex;align-items:center;justify-content:center;',
      'width:44px;height:44px;border-radius:10px;border:2px solid #e8e5e0;',
      'background:#fff;cursor:pointer;color:#6b6b6b;flex-shrink:0;',
      'transition:border-color .2s,background .2s,color .2s;',
      'touch-action:manipulation;-webkit-tap-highlight-color:transparent;position:relative;}',
      '.fl-voice-btn:hover{border-color:#c9a84c;color:#c9a84c;}',
      '.fl-voice-btn.fl-recording{border-color:#e07a5f;background:#faeae5;color:#e07a5f;',
      'animation:fl-vp 1.2s ease-in-out infinite;}',
      '.fl-voice-btn.fl-no-support{opacity:.4;cursor:not-allowed;}',
      '@keyframes fl-vp{0%,100%{box-shadow:0 0 0 0 rgba(224,122,95,.4);}',
      '50%{box-shadow:0 0 0 7px rgba(224,122,95,0);}}',
      '.fl-voice-btn svg{width:18px;height:18px;pointer-events:none;}',
      // Preview tooltip
      '.fl-voice-preview{display:none;position:absolute;bottom:calc(100% + 8px);right:0;',
      'background:#011e5c;color:#fff;padding:.45rem .7rem;border-radius:8px;',
      'font-size:.78rem;max-width:240px;min-width:120px;white-space:normal;',
      'z-index:9999;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,.18);',
      'font-family:"DM Sans",sans-serif;}',
      '.fl-voice-preview::after{content:"";position:absolute;top:100%;right:10px;',
      'border:6px solid transparent;border-top-color:#011e5c;}',
      '.fl-voice-preview.fl-vis{display:block;}',
      // Confirmation panel
      '.fl-voice-confirm{background:#fff;border:1px solid #e8e5e0;border-radius:10px;',
      'padding:.65rem .9rem;margin-top:.4rem;font-size:.83rem;display:none;',
      'font-family:"DM Sans",sans-serif;}',
      '.fl-voice-confirm.fl-vis{display:block;}',
      '.fl-voice-confirm p{margin-bottom:.45rem;color:#1a1a1a;line-height:1.4;}',
      '.fl-voice-confirm-btns{display:flex;gap:.4rem;}',
      '.fl-vc-yes{background:#5ba4a4;color:#fff;border:none;',
      'padding:.38rem .85rem;border-radius:6px;font-size:.8rem;',
      'cursor:pointer;touch-action:manipulation;font-family:"DM Sans",sans-serif;}',
      '.fl-vc-no{background:none;color:#6b6b6b;border:1px solid #e8e5e0;',
      'padding:.38rem .85rem;border-radius:6px;font-size:.8rem;',
      'cursor:pointer;touch-action:manipulation;font-family:"DM Sans",sans-serif;}',
      // Unsupported hint
      '.fl-voice-hint{font-size:.74rem;color:#e07a5f;padding:.3rem .5rem;',
      'background:#faeae5;border-radius:6px;display:none;margin-top:.3rem;',
      'font-family:"DM Sans",sans-serif;}',
      '.fl-voice-hint.fl-vis{display:block;}',
      // Journal overlay variant
      '.fl-voice-overlay-btn{position:absolute;bottom:10px;right:10px;z-index:10;}',
      '.fl-voice-overlay-btn .fl-voice-btn{background:rgba(255,255,255,.9);',
      'box-shadow:0 2px 8px rgba(0,0,0,.12);}',
      // ── NLP suggestion chips (v2) ─────────────────────────────────────────
      '.fl-nlp-chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.5rem;',
      'min-height:0;transition:all .15s ease;}',
      '.fl-nlp-chip{display:inline-flex;align-items:center;gap:.3rem;',
      'padding:.28rem .6rem;border-radius:20px;font-size:.76rem;font-weight:500;',
      'font-family:"DM Sans",sans-serif;border:1.5px solid transparent;',
      'cursor:default;animation:fl-chip-in .18s ease;line-height:1.3;',
      'max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '@keyframes fl-chip-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}',
      '.fl-chip-date{background:#EEF4FF;border-color:#BDD1FF;color:#2D5BE3;}',
      '.fl-chip-recur{background:#F0FDF4;border-color:#86EFAC;color:#16A34A;}',
      '.fl-chip-value{background:#FFF7ED;border-color:#FED7AA;color:#C2410C;}',
      '.fl-chip-dismiss{background:none;border:none;color:inherit;opacity:.6;',
      'cursor:pointer;padding:0;margin-left:.1rem;font-size:.9rem;line-height:1;',
      'flex-shrink:0;touch-action:manipulation;}',
      '.fl-chip-dismiss:hover{opacity:1;}',
    ].join('');
    document.head.appendChild(s);
  }

  // ─── SVG icons ────────────────────────────────────────────────────────────

  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>'
    + '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>'
    + '<line x1="12" y1="19" x2="12" y2="23"/>'
    + '<line x1="8" y1="23" x2="16" y2="23"/>'
    + '</svg>';

  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor">'
    + '<rect x="6" y="6" width="12" height="12" rx="2"/>'
    + '</svg>';

  // ─── escHtml ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── NLP Suggestion Chips ─────────────────────────────────────────────────
  // Creates/updates inline chips below a form input showing detected signals.
  // chipsContainer: a DOM element (created by caller if needed)
  // result: parsed NLP result
  // callbacks: { onDismissDate, onDismissRecur, onDismissValue }

  function renderNlpChips(chipsContainer, result, callbacks) {
    if (!chipsContainer) return;
    var cb = callbacks || {};
    var chips = [];

    if (result.dueDate) {
      var label = '📅 Due: ' + formatDateForDisplay(result.dueDate);
      chips.push({ key: 'date', cls: 'fl-chip-date', label: label, onDismiss: cb.onDismissDate });
    }

    if (result.recurrence) {
      var label = '🔁 Repeats ' + recurrenceLabel(result.recurrence);
      chips.push({ key: 'recur', cls: 'fl-chip-recur', label: label, onDismiss: cb.onDismissRecur });
    }

    if (result.matchedValue) {
      var label = '⭐ ' + result.matchedValue.value_name;
      chips.push({ key: 'value', cls: 'fl-chip-value', label: label, onDismiss: cb.onDismissValue });
    }

    if (chips.length === 0) {
      chipsContainer.innerHTML = '';
      return;
    }

    chipsContainer.innerHTML = chips.map(function(c) {
      return '<span class="fl-nlp-chip ' + c.cls + '" data-chip-key="' + c.key + '">'
        + esc(c.label)
        + '<button class="fl-chip-dismiss" data-chip-key="' + c.key + '" type="button" title="Dismiss" aria-label="Dismiss">✕</button>'
        + '</span>';
    }).join('');

    // Wire dismiss buttons
    chipsContainer.querySelectorAll('.fl-chip-dismiss').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var key = btn.dataset.chipKey;
        var chip = chipsContainer.querySelector('[data-chip-key="' + key + '"]');
        if (chip) chip.remove();
        if (key === 'date' && cb.onDismissDate) cb.onDismissDate();
        if (key === 'recur' && cb.onDismissRecur) cb.onDismissRecur();
        if (key === 'value' && cb.onDismissValue) cb.onDismissValue();
      });
    });
  }

  // "2026-05-15" → "May 15"
  function formatDateForDisplay(iso) {
    try {
      var parts = iso.split('-');
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate();
    } catch (e) {
      return iso;
    }
  }

  // ─── attach ───────────────────────────────────────────────────────────────

  function attach(opts) {
    injectStyles();

    var container    = opts.container;
    var targetInput  = opts.targetInput;
    var userValues   = opts.userValues || [];
    var onResult     = opts.onResult;
    var onTaskCreate = opts.onTaskCreate;
    var onExpenseLog = opts.onExpenseLog;
    var onCompleteTask = opts.onCompleteTask;
    var overlayMode  = opts.overlayMode || false;

    // Dedup guard: nuke ALL children of the container before injecting a new mic button.
    // Previous approach (querySelector + closest('div')) only removed one wrapper and
    // still left duplicates when attach() fired twice (DOMContentLoaded + fl-values-loaded).
    // These containers are dedicated voice-input hosts — safe to clear entirely.
    if (container) {
      container.innerHTML = '';
    }

    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var supported = !!SpeechRecognition;

    // Outer wrapper
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-flex;flex-direction:column;align-items:flex-end;';
    if (overlayMode) wrap.className = 'fl-voice-overlay-btn';

    // Preview tooltip
    var preview = document.createElement('div');
    preview.className = 'fl-voice-preview';
    preview.textContent = 'Listening\u2026';

    // Mic button
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fl-voice-btn' + (supported ? '' : ' fl-no-support');
    btn.setAttribute('aria-label', supported ? 'Voice input' : 'Voice input not supported');
    btn.title = supported ? 'Tap to speak' : 'Voice input requires Chrome, Edge, or Safari';
    btn.innerHTML = MIC_SVG;

    // Confirmation panel
    var confirmPanel = document.createElement('div');
    confirmPanel.className = 'fl-voice-confirm';

    // Unsupported hint
    var hint = document.createElement('div');
    hint.className = 'fl-voice-hint';
    hint.textContent = 'Voice input requires Chrome, Edge, or Safari';

    wrap.appendChild(preview);
    wrap.appendChild(btn);
    wrap.appendChild(confirmPanel);
    wrap.appendChild(hint);

    if (container) container.appendChild(wrap);

    if (!supported) {
      btn.addEventListener('click', function () {
        hint.classList.add('fl-vis');
        setTimeout(function () { hint.classList.remove('fl-vis'); }, 3200);
      });
      return { btn: btn, wrap: wrap };
    }

    var recognition = null;
    var isRecording = false;
    var finalText = '';
    var interimText = '';

    // ── Start recording ──────────────────────────────────────────────────────
    function startRecording() {
      isRecording = true;
      finalText = '';
      interimText = '';
      btn.classList.add('fl-recording');
      btn.innerHTML = STOP_SVG;
      btn.setAttribute('aria-label', 'Stop recording');
      preview.textContent = 'Listening\u2026';
      preview.classList.add('fl-vis');
      confirmPanel.classList.remove('fl-vis');
      confirmPanel.innerHTML = '';

      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.addEventListener('result', function (e) {
        var fin = '', intr = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) fin += e.results[i][0].transcript;
          else intr += e.results[i][0].transcript;
        }
        if (fin) finalText += fin;
        interimText = intr;
        var display = (finalText + interimText).trim();
        preview.textContent = display || 'Listening\u2026';
      });

      recognition.addEventListener('end', function () {
        if (isRecording) stopRecording(false);
      });

      recognition.addEventListener('error', function (e) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          preview.textContent = '\uD83C\uDFA4 Mic blocked \u2014 check browser permissions';
          setTimeout(function () { preview.classList.remove('fl-vis'); }, 4000);
        } else if (e.error === 'no-speech') {
          preview.textContent = '(nothing heard)';
          setTimeout(function () { preview.classList.remove('fl-vis'); }, 2000);
        }
        stopRecording(true);
      });

      try { recognition.start(); } catch (err) { stopRecording(true); }
    }

    // ── Stop recording ───────────────────────────────────────────────────────
    function stopRecording(isError) {
      isRecording = false;
      btn.classList.remove('fl-recording');
      btn.innerHTML = MIC_SVG;
      btn.setAttribute('aria-label', 'Voice input');

      if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
      }

      if (isError) return;

      var transcript = (finalText + interimText).trim();
      if (!transcript) { preview.classList.remove('fl-vis'); return; }

      handleTranscript(transcript);
    }

    // ── Handle transcript ────────────────────────────────────────────────────
    function handleTranscript(transcript) {
      var result = parseIntent(transcript, userValues);
      preview.classList.remove('fl-vis');

      if (onResult) onResult(transcript, result.intent, result);

      switch (result.intent) {
        case 'expense':
          showConfirm(
            'Log expense: <strong>' + esc('$' + result.amount
              + (result.merchant ? ' at ' + result.merchant : (result.description ? ' \u2014 ' + result.description : ''))) + '</strong>?',
            function () {
              if (onExpenseLog) onExpenseLog({ amount: result.amount, description: result.description, merchant: result.merchant, recurrence: result.recurrence, matchedValue: result.matchedValue });
              else fillExpense(result);
            }
          );
          break;

        case 'complete-task':
          showConfirm(
            'Complete task: <strong>' + esc(result.taskTitle) + '</strong>?',
            function () {
              if (onCompleteTask) onCompleteTask(result.taskTitle);
              else autoCompleteTask(result.taskTitle);
            }
          );
          break;

        case 'task':
          if (onTaskCreate) {
            onTaskCreate({ title: result.title, dueDate: result.dueDate, recurrence: result.recurrence, matchedValue: result.matchedValue });
          } else {
            fillTaskInput(result.title, result.dueDate, result.recurrence);
          }
          break;

        case 'journal':
          fillTextEl(document.getElementById('journalTextarea') || targetInput, transcript);
          break;

        default: // ambiguous
          if (targetInput) fillTextEl(targetInput, transcript);
          // Still apply any detected signals to the form
          applySignalsToForm(result);
      }
    }

    // ── Show confirm panel ───────────────────────────────────────────────────
    function showConfirm(html, onYes) {
      confirmPanel.innerHTML = '<p>' + html + '</p>'
        + '<div class="fl-voice-confirm-btns">'
        + '<button class="fl-vc-yes" type="button">Yes, do it</button>'
        + '<button class="fl-vc-no" type="button">Cancel</button>'
        + '</div>';
      confirmPanel.classList.add('fl-vis');
      confirmPanel.querySelector('.fl-vc-yes').addEventListener('click', function () {
        onYes();
        confirmPanel.classList.remove('fl-vis');
        confirmPanel.innerHTML = '';
      });
      confirmPanel.querySelector('.fl-vc-no').addEventListener('click', function () {
        confirmPanel.classList.remove('fl-vis');
        confirmPanel.innerHTML = '';
      });
    }

    // ── Fill helpers ──────────────────────────────────────────────────────────
    function fillTextEl(el, text) {
      if (!el) return;
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
      el.focus();
    }

    function fillTaskInput(title, dueDate, recurrence) {
      var inp = document.getElementById('taskInput') || targetInput;
      if (inp) fillTextEl(inp, title);

      if (dueDate) {
        var dueFld = document.getElementById('newTaskDueDate');
        if (dueFld) {
          var toggleBtn = document.getElementById('dueDateToggleBtn');
          var area = document.getElementById('dueDateInputsArea');
          if (area && toggleBtn) {
            var hidden = area.style.display === 'none' || !area.classList.contains('visible');
            if (hidden) toggleBtn.click();
          }
          setTimeout(function () {
            dueFld.value = dueDate;
            dueFld.dispatchEvent(new Event('change', { bubbles: true }));
          }, 80);
        }
      }

      // Auto-set recurrence selector if detected
      if (recurrence) {
        var repeatBtn = document.getElementById('repeatToggleBtn');
        var repeatArea = document.getElementById('repeatOptionsArea');
        var repeatSel = document.getElementById('repeatFrequency');
        if (repeatSel) {
          // Map 'annually' → 'yearly' to match the select option value
          var selVal = recurrence === 'annually' ? 'yearly' : recurrence;
          // Show the repeat panel if hidden
          if (repeatBtn && repeatArea && !repeatArea.classList.contains('visible')) {
            repeatBtn.click();
          }
          setTimeout(function() {
            repeatSel.value = selVal;
            repeatSel.dispatchEvent(new Event('change', { bubbles: true }));
          }, 80);
        }
      }
    }

    function fillExpense(result) {
      var amtEl = document.getElementById('expenseAmount');
      var descEl = document.getElementById('expenseDesc');
      if (amtEl) {
        amtEl.value = result.amount;
        amtEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (descEl) {
        fillTextEl(descEl, result.merchant || result.description || '');
      }

      // Auto-set recurrence for expense if detected
      if (result.recurrence) {
        var expRepeatBtn = document.getElementById('expenseRepeatBtn');
        var expRepeatFreq = document.getElementById('expenseRepeatFreq');
        var expRepeatSel = document.getElementById('expenseRepeatFrequency');
        if (expRepeatSel) {
          var selVal = result.recurrence === 'annually' ? 'yearly' : result.recurrence;
          if (expRepeatBtn && expRepeatFreq && !expRepeatFreq.classList.contains('visible')) {
            expRepeatBtn.click();
          }
          setTimeout(function() {
            expRepeatSel.value = selVal;
            expRepeatSel.dispatchEvent(new Event('change', { bubbles: true }));
          }, 80);
        }
      }
    }

    function applySignalsToForm(result) {
      // For ambiguous intent, apply any detected signals to the current context
      if (result.dueDate) {
        var dueFld = document.getElementById('newTaskDueDate');
        if (dueFld) {
          var toggleBtn = document.getElementById('dueDateToggleBtn');
          var area = document.getElementById('dueDateInputsArea');
          if (area && toggleBtn && !area.classList.contains('visible')) toggleBtn.click();
          setTimeout(function() {
            dueFld.value = result.dueDate;
            dueFld.dispatchEvent(new Event('change', { bubbles: true }));
          }, 80);
        }
      }
    }

    function autoCompleteTask(taskTitle) {
      var titles = document.querySelectorAll('.task-title:not(.struck)');
      var query = taskTitle.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
      if (!query.length) return;
      var bestEl = null, bestScore = 0;
      for (var i = 0; i < titles.length; i++) {
        var text = (titles[i].textContent || '').toLowerCase();
        var hits = query.filter(function (w) { return text.indexOf(w) !== -1; }).length;
        var score = hits / query.length;
        if (score > bestScore && score >= 0.4) { bestScore = score; bestEl = titles[i]; }
      }
      if (bestEl) {
        var card = bestEl.closest('.task-card');
        if (card) {
          var cb = card.querySelector('.task-checkbox:not(.done)');
          if (cb) cb.click();
        }
      }
    }

    // ── Button click ─────────────────────────────────────────────────────────
    btn.addEventListener('click', function () {
      if (isRecording) stopRecording(false);
      else startRecording();
    });

    return { btn: btn, wrap: wrap };
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  global.VoiceInput = {
    attach: attach,
    // NLP namespace: parse text (typed or voice) against optional userValues array
    NLP: {
      parse: parseIntent,
      extractDueDate: extractDueDate,
      extractRecurrence: extractRecurrence,
      matchValue: matchValueFromText,
      renderChips: renderNlpChips,
      formatDateForDisplay: formatDateForDisplay,
      recurrenceLabel: recurrenceLabel,
    }
  };

}(window));
