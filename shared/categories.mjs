// Shared, dependency-free constants + helpers for the email digest.
// Safe to import from the Cloudflare Worker, the Node feed builder, and the
// local preview script alike. NO node builtins in here.

// ── Fixed "Munshot newspaper" palette (verbatim) ──────────────────────────
export const PALETTE = {
  ink: '#1a1712',
  paper: '#fbf9f3',
  cream: '#f2eee3',
  rule: '#d9d2c2',
  meta: '#8a8272',
  link: '#b4531f',
  // secondary text tones used by the newspaper body
  body: '#4a4438',
  bodySoft: '#5c5445',
};

// ── Status (sentiment) colours ────────────────────────────────────────────
export const STATUS = {
  positive: { color: '#10b981', label: 'Gainer' },
  negative: { color: '#f43f5e', label: 'Decliner' },
  neutral: { color: '#94a3b8', label: 'Flat' },
};

// ── Category palette ──────────────────────────────────────────────────────
// Each dashboard category gets ONE colour from the fixed list. Rose (#f43f5e)
// is intentionally left for the "negative" status dot so the two never clash.
export const CATEGORIES = [
  { key: 'market', label: 'Market', color: '#3b82f6' }, // blue
  { key: 'results', label: 'Results', color: '#10b981' }, // green
  { key: 'investor', label: 'Investor', color: '#8b5cf6' }, // violet
  { key: 'board', label: 'Board & Actions', color: '#f59e0b' }, // amber
  { key: 'ratings', label: 'Ratings', color: '#14b8a6' }, // teal
  { key: 'press', label: 'Press', color: '#64748b' }, // slate
];

export const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

// BSE docType → digest category. docTypes not listed here are treated as
// low-signal noise (compliance, insider-trading, "other", …) and dropped.
export const DOCTYPE_TO_CATEGORY = {
  'quarterly-result': 'results',
  'integrated-filing': 'results',
  'annual-report': 'results',
  'investor-presentation': 'investor',
  'investor-meet-outcome': 'investor',
  'analyst-meet-intimation': 'investor',
  'concall-transcript': 'investor',
  'board-meeting-outcome': 'board',
  'board-meeting-intimation': 'board',
  'corp-action': 'board',
  'agm-egm': 'board',
  'credit-rating': 'ratings',
  'press-release': 'press',
  'newspaper-advert': 'press',
  'new-listing': 'press',
};

// Human labels for a filing headline, derived from docType.
export const DOCTYPE_LABEL = {
  'quarterly-result': 'Quarterly Results',
  'integrated-filing': 'Integrated Filing',
  'annual-report': 'Annual Report',
  'investor-presentation': 'Investor Presentation',
  'investor-meet-outcome': 'Investor Meet Outcome',
  'analyst-meet-intimation': 'Analyst Meet',
  'concall-transcript': 'Earnings Call Transcript',
  'board-meeting-outcome': 'Board Meeting Outcome',
  'board-meeting-intimation': 'Board Meeting',
  'corp-action': 'Corporate Action',
  'agm-egm': 'AGM / EGM',
  'credit-rating': 'Credit Rating Update',
  'press-release': 'Press Release',
  'newspaper-advert': 'Public Notice',
  'new-listing': 'Listing Update',
};

// ── Small pure helpers ────────────────────────────────────────────────────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Parse a 'YYYY-MM-DD' (or ISO) string to a UTC Date, or pass a Date through.
export function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'string') {
    const s = d.length === 10 ? d + 'T00:00:00Z' : d;
    const dt = new Date(s);
    return isNaN(dt) ? null : dt;
  }
  return null;
}

// "Tuesday, 9 September 2026"
export function formatDateFull(d) {
  const dt = toDate(d);
  if (!dt) return '';
  return `${WEEKDAYS[dt.getUTCDay()]}, ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

// "7 Sep"
export function formatDayMon(d) {
  const dt = toDate(d);
  if (!dt) return '';
  return `${dt.getUTCDate()} ${MONTHS_ABBR[dt.getUTCMonth()]}`;
}

// 'YYYY-MM-DD' for a Date, using its UTC parts.
export function isoDate(d) {
  const dt = toDate(d);
  if (!dt) return '';
  return dt.toISOString().slice(0, 10);
}

// "now" shifted into IST (UTC+5:30). Read its getUTC* parts as IST wall-clock.
export function nowIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000);
}

// IST calendar date 'YYYY-MM-DD'.
export function istDateStr() {
  return nowIST().toISOString().slice(0, 10);
}

// IST "HH:MM" (24h, zero-padded) — comparable as a string.
export function istTimeHHMM() {
  return nowIST().toISOString().slice(11, 16);
}

// 0=Sun … 6=Sat, in IST.
export function istWeekday() {
  return nowIST().getUTCDay();
}

// Strip the boilerplate "Announcement under Regulation 30 (LODR)-" prefix and
// tidy a BSE subject into a readable one-liner.
export function cleanSubject(subject = '') {
  return String(subject)
    .replace(/^Announcement under Regulation \d+\s*\(LODR\)\s*[-–—:]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "FY26-Q4" → "Q4 FY26"
export function prettyQuarter(fq = '') {
  const m = /^FY(\d{2})-Q([1-4])$/.exec(fq || '');
  return m ? `Q${m[2]} FY${m[1]}` : (fq || '');
}

// Escape text for safe inline HTML.
export function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
