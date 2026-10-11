'use strict';
/**
 * Merchant patterns and merchant-key normalization shared by bank sync
 * (routes/plaid.js) and the bill guardian (lib/bill-guardian.js). Both must
 * produce identical keys: bill_preferences is keyed on them.
 */

const BILL_MERCHANT_PATTERNS = [
  { pattern: /netflix/i, type: 'subscription', label: 'Netflix' },
  { pattern: /spotify/i, type: 'subscription', label: 'Spotify' },
  { pattern: /hulu/i, type: 'subscription', label: 'Hulu' },
  { pattern: /disney+?/i, type: 'subscription', label: 'Disney+' },
  { pattern: /apple.*(tv|music|one)/i, type: 'subscription', label: 'Apple Subscription' },
  { pattern: /amazon.*(prime|video)/i, type: 'subscription', label: 'Amazon Prime' },
  { pattern: /youtube.*premium/i, type: 'subscription', label: 'YouTube Premium' },
  { pattern: /hbo|max\b/i, type: 'subscription', label: 'HBO Max' },
  { pattern: /paramount/i, type: 'subscription', label: 'Paramount+' },
  { pattern: /peacock/i, type: 'subscription', label: 'Peacock' },
  { pattern: /adobe/i, type: 'subscription', label: 'Adobe' },
  { pattern: /microsoft *(365|office)/i, type: 'subscription', label: 'Microsoft 365' },
  { pattern: /dropbox/i, type: 'subscription', label: 'Dropbox' },
  { pattern: /icloud/i, type: 'subscription', label: 'iCloud' },
  { pattern: /google *(one|workspace)/i, type: 'subscription', label: 'Google One' },
  { pattern: /sirius.*xm|siriusxm/i, type: 'subscription', label: 'SiriusXM' },
  { pattern: /audible/i, type: 'subscription', label: 'Audible' },
  { pattern: /con *ed|consolidated *edison/i, type: 'utility', label: 'Con Edison' },
  { pattern: /pge|pacific *gas/i, type: 'utility', label: 'PG&E' },
  { pattern: /duke *energy/i, type: 'utility', label: 'Duke Energy' },
  { pattern: /dominion *energy/i, type: 'utility', label: 'Dominion Energy' },
  { pattern: /xcel *energy/i, type: 'utility', label: 'Xcel Energy' },
  { pattern: /national *grid/i, type: 'utility', label: 'National Grid' },
  { pattern: /eversource/i, type: 'utility', label: 'Eversource' },
  { pattern: /pepco|potomac *electric/i, type: 'utility', label: 'PEPCO' },
  { pattern: /nicor *gas/i, type: 'utility', label: 'Nicor Gas' },
  { pattern: /national *fuel/i, type: 'utility', label: 'National Fuel Gas' },
  { pattern: /water *(authority|service|works|dept|utility)/i, type: 'utility', label: 'Water Utility' },
  { pattern: /american *water/i, type: 'utility', label: 'American Water' },
  { pattern: /verizon/i, type: 'utility', label: 'Verizon' },
  { pattern: /at&t|\batatt\b/i, type: 'utility', label: 'AT&T' },
  { pattern: /t.?mobile/i, type: 'utility', label: 'T-Mobile' },
  { pattern: /comcast|xfinity/i, type: 'utility', label: 'Comcast/Xfinity' },
  { pattern: /spectrum/i, type: 'utility', label: 'Spectrum' },
  { pattern: /cox *communications/i, type: 'utility', label: 'Cox' },
  { pattern: /centurylink|lumen/i, type: 'utility', label: 'CenturyLink' },
  { pattern: /geico/i, type: 'insurance', label: 'GEICO' },
  { pattern: /state *farm/i, type: 'insurance', label: 'State Farm' },
  { pattern: /progressive/i, type: 'insurance', label: 'Progressive' },
  { pattern: /allstate/i, type: 'insurance', label: 'Allstate' },
  { pattern: /liberty *mutual/i, type: 'insurance', label: 'Liberty Mutual' },
  { pattern: /usaa/i, type: 'insurance', label: 'USAA' },
  { pattern: /aetna/i, type: 'insurance', label: 'Aetna' },
  { pattern: /blue *cross|bcbs/i, type: 'insurance', label: 'Blue Cross' },
  { pattern: /united *health(care)?/i, type: 'insurance', label: 'UnitedHealthcare' },
  { pattern: /cigna/i, type: 'insurance', label: 'Cigna' },
  { pattern: /humana/i, type: 'insurance', label: 'Humana' },
  { pattern: /rent *payment|property *management/i, type: 'rent', label: 'Rent Payment' },
  { pattern: /wells *fargo *mortgage/i, type: 'rent', label: 'Wells Fargo Mortgage' },
  { pattern: /chase *mortgage/i, type: 'rent', label: 'Chase Mortgage' },
  { pattern: /rocket *mortgage/i, type: 'rent', label: 'Rocket Mortgage' },
  { pattern: /student *loan|sallie *mae|navient/i, type: 'loan', label: 'Student Loan' },
  { pattern: /auto *loan|car *payment/i, type: 'loan', label: 'Car Payment' },
];

function normalizeMerchantKey(name) {
  return (name || '')
    .toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').substring(0, 100);
}

module.exports = { BILL_MERCHANT_PATTERNS, normalizeMerchantKey };
