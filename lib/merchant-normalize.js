'use strict';
/**
 * Merchant / payee name normalization for bank transactions.
 *
 * Bank descriptors are noisy: "SQ *JOES COFFEE 4421", "JOES COFFEE #12 SEATTLE WA",
 * "TST* BLUE DOOR CAFE", "PAYPAL *NETFLIX 4029357733 CA", "COMCAST DES:CABLE ID:8822 INDN:...".
 * This turns them into one readable name ("Joes Coffee") and one grouping key
 * ("joes_coffee"), so the bill guardian sees one recurring stream per merchant.
 *
 *   cleanMerchantName(raw)   readable, title-cased name (display)
 *   merchantKey(name)        grouping key built from the cleaned name
 *   transactionMerchant(tx)  { name, key, legacyKey } for a plaid_transactions row,
 *                            preferring Plaid's merchant_name over the raw description
 *
 * `legacyKey` is the key the app used before this module existed
 * (lib/bill-patterns.js normalizeMerchantKey on the raw name). bill_preferences
 * rows and tasks.bill_merchant_key were written with it, so callers use it to
 * find existing user answers (lib/bill-guardian.js resolvePrefKeys).
 *
 * Title-casing follows Actual Budget's payee "title-case" normalization
 * (packages/loot-core/src/server/accounts/title, MIT; see THIRD_PARTY_NOTICES.md):
 * lower everything, capitalise each word, keep short connector words lower
 * case, then apply a list of special spellings. The descriptor stripping
 * (processor prefixes, store numbers, locations, reference ids) is our own.
 * Pure functions, no I/O.
 */
const { normalizeMerchantKey } = require('./bill-patterns');

// Payment processors / POS systems that prepend their own code to the
// merchant: Square, Toast, PayPal, Shopify, Paytrace, Braintree, Checkout.com,
// Intuit, WePay, Clover, Eventbrite, Instacart, Lightspeed, SumUp, Zettle.
const PROCESSOR_PREFIX = /^(?:SP AFF|SQ|SQU|SQC|TST|PAYPAL|PP|SP|PY|BT|CKO|IN|WPY|CLV|EB|IC|LS|SUMUP|SMP|ZTL|IZ|PAR|FS|GOOGLE PAY|APPLE PAY)\s*\*\s*/;
// Same codes when the bank drops the asterisk ("PAYPAL NETFLIX"): only the
// unambiguous long ones, a two-letter code alone is too likely to be a word.
const PROCESSOR_PREFIX_NO_STAR = /^(?:PAYPAL|SUMUP|GOOGLE PAY|APPLE PAY)\s+(?=\S)/;

// Card-network / bank boilerplate in front of the merchant.
const LEADING_NOISE = [
  /^(?:RECURRING )?(?:PURCHASE|PAYMENT) AUTHORIZED ON\s+\d{1,2}\/\d{1,2}\s*/,
  /^(?:RECURRING |DEBIT |CHECK ?CARD |VISA |MC )?(?:CARD )?PURCHASE(?: WITH PIN| RETURN)?\s+(?:\d{1,2}\/\d{1,2}\s+)?/,
  /^CHECK ?CARD\s+(?:\d{4}\s+)?/,
  /^POS(?: DEBIT| PURCHASE| PUR| WITHDRAWAL)?\s+/,
  /^(?:DBT|DEBIT) (?:CRD|CARD)\s+(?:\d{4}\s+)?/,
  /^VISA DDA PUR\s+(?:\d+\s+)?/,
  /^(?:ACH|PREAUTHORIZED|PRE-AUTHORIZED|ELECTRONIC|ONLINE|RECURRING|AUTOMATIC) (?:DEBIT|WITHDRAWAL|PAYMENT|PMT|TRANSFER)\s+/,
  /^ACH\s+(?:DEBIT\s+)?/,
  /^WWW\./,
];

// ACH descriptors after the company name ("COMCAST DES:CABLE ID:8822 INDN:JANE DOE CO ID:...").
const ACH_TAIL = /\s+(?:DES|INDN|CO ID|ID|PPD ID|WEB ID|CCD ID|ORIG CO NAME|ORIG ID|SEC|TRACE|REF|CONF|TRN|AUTH)\s*[:#].*$/;

// Tokens that are noise wherever they appear after the first word.
const CARD_DIGITS = /\b(?:X{2,}\d{2,4}|\*{2,}\d{2,4}|\.{2,}\d{2,4}|(?:CARD|CRD|ACCT|ACCOUNT)\s*(?:ENDING(?: IN)?\s*)?#?\s*\d{4}|ENDING IN\s*\d{4})\b/g;
const PHONE = /\b(?:1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g;
const DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const STORE_NUMBER = /(?:#\s*\d+|\b(?:STORE|STR|STO|NO|NUM|UNIT|LOC)\.?\s*#?\s*\d+)\b/g;
const REF_LABEL = /\b(?:REF|CONF|INV|ORDER|ORD|TXN|TRANS)\s*[#:.]?\s*[A-Z0-9-]*\d[A-Z0-9-]*\b/g;
const WEB_SUFFIX = /\.(?:COM|NET|ORG|IO|CO|US|TV)\b(?:\/\S*)?/g;

// Trailing words that say how it was paid, not who was paid.
const TRAILING_NOISE = /\s+(?:AUTOPAY|AUTO PAY|AUTO-PAY|ONLINE PMT|ONLINE PAYMENT|WEB PMT|PMT|PYMT|RECURRING|RECUR|PURCHASE|POS|DEBIT|ACH|USA|US)$/;
// "VERIZON WIRELESS PAYMENTS", "AT&T *PAYMENT": dropped unless the word left
// in front is generic ("RENT PAYMENT", "CAR PAYMENT" name the bill itself).
const TRAILING_PAYMENT = /\s+(?:PAYMENTS?|PMTS?|PYMTS?|BILL ?PAY(?:MENT)?)$/;
const GENERIC_BEFORE_PAYMENT = new Set(['RENT', 'LOAN', 'CARD', 'CRD', 'MORTGAGE', 'CAR', 'AUTO', 'BILL', 'ONLINE', 'INSURANCE', 'INS', 'TAX', 'CREDIT', 'STUDENT', 'HOA', 'UTILITY', 'WATER']);
const WEEKDAY_TIME = /\b(?:MON|TUE|WED|THU|FRI|SAT|SUN)\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/g;
// "HELP.UBER.COM", "G.CO/HELPPAY#", "AMZN.COM/BILL" after the merchant word.
const DOMAIN_TOKEN = /^[A-Z0-9-]+(?:\.[A-Z0-9-]+)+(?:\/\S*)?$|^\S*\/\S*#$/;

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' ');
// Codes that are also ordinary words in merchant names ("JOES PIZZA CO",
// "IN-N-OUT", "PIZZA ME"): only stripped when a known city or a number
// (zip, phone residue) sits in front of them.
const AMBIGUOUS_STATES = new Set(['AL', 'CO', 'DE', 'HI', 'ID', 'IN', 'LA', 'MA', 'ME', 'MO', 'OH', 'OK', 'OR', 'PA']);
const STATE_SET = new Set(STATES);

// Cities that show up most in US card descriptors. Not exhaustive: a city we
// don't know stays in the name, which only costs grouping when the same
// merchant also appears without it.
const CITIES = [
  'NEW YORK', 'BROOKLYN', 'BRONX', 'QUEENS', 'STATEN ISLAND', 'MANHATTAN', 'LOS ANGELES', 'SAN FRANCISCO',
  'SAN DIEGO', 'SAN JOSE', 'SAN ANTONIO', 'SANTA MONICA', 'SANTA CLARA', 'SANTA ANA', 'SACRAMENTO', 'OAKLAND',
  'BERKELEY', 'PALO ALTO', 'MOUNTAIN VIEW', 'SUNNYVALE', 'LONG BEACH', 'FRESNO', 'IRVINE', 'PASADENA',
  'CHICAGO', 'HOUSTON', 'DALLAS', 'AUSTIN', 'FORT WORTH', 'EL PASO', 'PLANO', 'ARLINGTON', 'PHOENIX',
  'SCOTTSDALE', 'TEMPE', 'MESA', 'TUCSON', 'PHILADELPHIA', 'PITTSBURGH', 'JACKSONVILLE', 'MIAMI', 'ORLANDO',
  'TAMPA', 'FORT LAUDERDALE', 'ATLANTA', 'COLUMBUS', 'CLEVELAND', 'CINCINNATI', 'CHARLOTTE', 'RALEIGH',
  'DURHAM', 'INDIANAPOLIS', 'SEATTLE', 'BELLEVUE', 'REDMOND', 'TACOMA', 'SPOKANE', 'PORTLAND', 'DENVER',
  'BOULDER', 'WASHINGTON', 'BALTIMORE', 'BOSTON', 'CAMBRIDGE', 'SOMERVILLE', 'NASHVILLE', 'MEMPHIS',
  'LOUISVILLE', 'DETROIT', 'MILWAUKEE', 'MADISON', 'MINNEAPOLIS', 'SAINT PAUL', 'ST PAUL', 'ST LOUIS',
  'SAINT LOUIS', 'KANSAS CITY', 'OMAHA', 'LAS VEGAS', 'HENDERSON', 'RENO', 'ALBUQUERQUE', 'SALT LAKE CITY',
  'OKLAHOMA CITY', 'TULSA', 'NEW ORLEANS', 'RICHMOND', 'VIRGINIA BEACH', 'ALEXANDRIA',
  'HONOLULU', 'ANCHORAGE', 'BOISE', 'DES MOINES', 'BUFFALO', 'ROCHESTER', 'NEWARK', 'JERSEY CITY',
  'HOBOKEN', 'HARTFORD', 'PROVIDENCE', 'BURLINGTON', 'CHARLESTON', 'BIRMINGHAM', 'LITTLE ROCK',
  'SAN MATEO', 'REDWOOD CITY', 'MENLO PARK', 'CUPERTINO', 'BURBANK', 'GLENDALE', 'ANAHEIM', 'RIVERSIDE',
  'SAN BERNARDINO', 'STAMFORD', 'WHITE PLAINS', 'EVANSTON', 'ANN ARBOR', 'COLUMBIA', 'GREENVILLE',
  'SPRINGFIELD', 'FAIRFAX', 'BETHESDA', 'SILVER SPRING', 'ROCKVILLE', 'MCLEAN', 'TOWSON',
  // Common in online-merchant descriptors
  'LOS GATOS', 'SAN BRUNO',
].sort((a, b) => b.length - a.length);

// ── Title case (after Actual Budget's title(): MIT, see THIRD_PARTY_NOTICES.md) ──
// Connector words kept lower case unless first. Actual's full list (all
// English prepositions) is trimmed to the ones that read naturally in
// merchant names: "Bed Bath and Beyond", "Bank of America".
const LOWER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'for', 'of', 'at', 'by', 'in', 'on', 'to', 'via', 'per', 'with',
]);
// Exact spellings applied after casing (Actual's "specials" list, rewritten for merchants).
const SPECIALS = [
  'AT&T', 'PG&E', 'H&M', 'A&W', 'TJ', 'TJX', 'CVS', 'BP', 'KFC', 'IHOP', 'USAA', 'GEICO', 'HBO', 'ESPN',
  'AMC', 'ADT', 'UPS', 'USPS', 'DMV', 'IRS', 'HOA', 'YMCA', 'LLC', 'ATM', 'NYC', 'LA', 'DC', 'BJ\'s', 'QT',
  'BMW', 'IKEA', 'REI', 'AAA', 'ABC', 'NBC', 'CBS', 'SXM', 'TV', 'PBS', 'NPR', 'BBQ', 'MLB', 'NBA', 'NFL',
  'GNC', 'HSN', 'QVC', 'PNC', 'TD', 'BofA', 'USA', 'UK', 'EZ', 'JCPenney', 'PetSmart', 'iCloud', 'iTunes',
  'eBay', 'YouTube', 'PayPal', 'DoorDash', 'GrubHub', 'LinkedIn', 'OpenAI', 'ChatGPT', 'SiriusXM',
  'McDonald\'s', 'T-Mobile', 'Wi-Fi',
];
const SPECIAL_RE = SPECIALS.map(s => [new RegExp(`(^|[^A-Za-z0-9'&])${s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}(?=$|[^A-Za-z0-9'&])`, 'gi'), s]);

function titleCase(str) {
  const words = String(str || '').toLowerCase().split(' ');
  let out = words.map((w, i) => {
    if (!w) return w;
    if (i > 0 && LOWER_WORDS.has(w)) return w;
    // Capitalise after word starts, hyphens and slashes; not after apostrophes ("Joe's").
    return w.replace(/(^|[-/.(])([a-z0-9])/g, (m, lead, c) => lead + c.toUpperCase())
      .replace(/^Mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  }).join(' ');
  for (const [re, s] of SPECIAL_RE) out = out.replace(re, (m, lead) => lead + s);
  return out;
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** True when the string has no lower-case letters or no upper-case letters (raw bank casing). */
function isSingleCase(s) {
  return !/[a-z]/.test(s) || !/[A-Z]/.test(s);
}

function stripLocation(s) {
  // Fixed-width descriptors ("JOES COFFEE      SEATTLE      WA") put the
  // location in its own column: the merchant is the first column.
  let out = s;
  for (let changed = true; changed;) {
    changed = false;
    const tokens = out.split(' ');
    const last = tokens[tokens.length - 1];
    // Zip codes and trailing bare numbers (store ids, phone residue).
    if (tokens.length > 1 && /^\d+$/.test(last)) {
      out = tokens.slice(0, -1).join(' '); changed = true; continue;
    }
    if (tokens.length > 1 && STATE_SET.has(last)) {
      const before = tokens.slice(0, -1).join(' ');
      const city = CITIES.find(c => before === c || before.endsWith(' ' + c));
      if (city && before.length > city.length) {
        out = before.slice(0, -city.length).trim(); changed = true; continue;
      }
      if (!AMBIGUOUS_STATES.has(last)) {
        out = before; changed = true; continue;
      }
    }
    // "... SEATTLE" with the state already gone.
    if (tokens.length > 1) {
      const city = CITIES.find(c => out.endsWith(' ' + c));
      if (city && out.length - city.length - 1 > 0) {
        out = out.slice(0, -city.length - 1).trim(); changed = true; continue;
      }
    }
  }
  return out;
}

/**
 * Strip descriptor noise from a raw bank string. Returns upper-case text,
 * or '' when nothing merchant-like is left.
 */
function stripDescriptor(raw) {
  let s = String(raw || '').toUpperCase().replace(/[‘’]/g, "'");
  // A run of 3+ spaces separates fixed-width columns: keep the first.
  const firstColumn = s.trim().split(/\s{3,}/)[0];
  s = squash(firstColumn);

  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const re of LEADING_NOISE) s = s.replace(re, '');
    s = s.replace(PROCESSOR_PREFIX, '').replace(PROCESSOR_PREFIX_NO_STAR, '');
    s = squash(s);
    if (s === before) break;
  }

  s = s.replace(ACH_TAIL, '');
  // "BLUE DOOR CAFE - 123 MAIN ST": a street address after a dash.
  s = s.replace(/\s+-\s+\d.*$/, '');
  s = s.split(' ').filter((t, i) => i === 0 || !DOMAIN_TOKEN.test(t)).join(' ');
  s = s.replace(WEEKDAY_TIME, ' ');
  s = s.replace(CARD_DIGITS, ' ').replace(PHONE, ' ').replace(DATE, ' ')
    .replace(REF_LABEL, ' ').replace(STORE_NUMBER, ' ').replace(WEB_SUFFIX, ' ');

  // "AMAZON MKTPLACE PMTS*2K4AB1C23" / "SPOTIFY*P1234ABC": the part after the
  // star is an order/reference id when it carries digits; otherwise it names
  // the product ("UBER *EATS") and stays.
  s = s.replace(/\s*\*\s*([A-Z0-9]*\d[A-Z0-9]*)\b/g, ' ').replace(/\s*\*\s*/g, ' ');

  // Words that mix letters and 3+ digits (reference ids like "P1A2B3C4", "W1234")
  // after the first word; pure numbers after the first word.
  const tokens = squash(s).split(' ');
  s = tokens.filter((t, i) => i === 0 || !(/\d/.test(t) && (t.replace(/\D/g, '').length >= 3 || /^\d+$/.test(t)))).join(' ');

  s = squash(s.replace(/[,;:]+/g, ' ').replace(/\s-\s/g, ' '));
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = stripLocation(s);
    s = s.replace(TRAILING_NOISE, '');
    const pay = s.match(TRAILING_PAYMENT);
    if (pay) {
      const rest = s.slice(0, pay.index).trim();
      const lastWord = rest.split(' ').pop();
      if (rest && !GENERIC_BEFORE_PAYMENT.has(lastWord)) s = rest;
    }
    s = squash(s.replace(/[\s\-#/.&*]+$/, '').replace(/^[\s\-#/.*]+/, ''));
    if (s === before) break;
  }
  return /[A-Z]/.test(s) ? s : '';
}

/**
 * Readable merchant name from a raw bank descriptor or a Plaid merchant_name.
 * Mixed-case input (Plaid's cleaned names: "McDonald's", "YouTube Premium")
 * is trusted and only trimmed; single-case input is cleaned and title-cased.
 * @param {string} raw
 * @param {{descriptor?: boolean}} [opts] descriptor: true always cleans, even
 *   mixed case (Plaid's raw `name` is often "AMZN Mktp US*2K4AB1C23")
 * @returns {string} '' when nothing usable
 */
function cleanMerchantName(raw, { descriptor = false } = {}) {
  const text = squash(String(raw || ''));
  if (!text) return '';
  if (!descriptor && !isSingleCase(text)) {
    // Already curated, but still drop a processor prefix if one slipped in.
    const m = text.toUpperCase().match(PROCESSOR_PREFIX);
    return m ? squash(text.slice(m[0].length)) || text : text;
  }
  const stripped = stripDescriptor(text);
  return stripped ? titleCase(stripped) : titleCase(text);
}

/**
 * Grouping key for a merchant name. Apostrophes are dropped first so
 * "Joe's Coffee" (Plaid) and "JOES COFFEE" (raw) land on the same key.
 * @returns {string} '' when nothing usable
 */
function merchantKey(name) {
  return normalizeMerchantKey(cleanMerchantName(name).replace(/['’]/g, ''));
}

/**
 * Name and keys for one plaid_transactions row.
 * @param {{merchant_name?: string, description?: string}} tx
 * @returns {{name: string, key: string, legacyKey: string, raw: string}}
 */
function transactionMerchant(tx) {
  const merchant = squash(String((tx && tx.merchant_name) || ''));
  const description = squash(String((tx && tx.description) || ''));
  const raw = merchant || description;
  const legacyKey = normalizeMerchantKey(raw);
  let name = cleanMerchantName(merchant) || cleanMerchantName(description, { descriptor: true });
  let key = merchantKey(name);
  if (!key) { key = legacyKey; name = name || raw; }
  return { name, key, legacyKey, raw };
}

module.exports = {
  cleanMerchantName,
  merchantKey,
  transactionMerchant,
  _internal: { stripDescriptor, titleCase, isSingleCase },
};
