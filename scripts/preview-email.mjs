// Local preview: build the feed from ./data, render the digest with the SAME
// pure renderer the Worker uses, and write ./email-preview.html to eyeball in a
// browser before anything is ever sent.
//
//   node scripts/preview-email.mjs                 # full brief, daily
//   node scripts/preview-email.mjs market,results  # only those sections
//   node scripts/preview-email.mjs --empty         # preview the empty state

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../shared/build-feed.mjs';
import { selectDigest, normalizeSections } from '../shared/select.mjs';
import { renderDigestEmail } from '../shared/digest-email.mjs';
import { formatDateFull, formatDayMon, nowIST } from '../shared/categories.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SITE = process.env.SITE_URL || 'https://hospitaldash.example.workers.dev';

const arg = process.argv[2] || '';
const empty = process.argv.includes('--empty');
const sections = arg && !arg.startsWith('--') ? arg.split(',').map((s) => s.trim()) : 'all';

const feed = await buildFeed(DATA);
const sel = selectDigest(feed, { sections, moverUrl: SITE });

// Force the empty state for a visual check.
if (empty) {
  sel.frontPage = [];
  sel.sections = [];
  sel.total = 0;
  sel.byNumbers = { total: 0, positive: 0, negative: 0, busiestLabel: '—', busiestColor: '#1a1712' };
}

const wanted = normalizeSections(sections);
const cadenceLabel = 'every day';

const model = {
  product: feed.product,
  brandLogoUrl: process.env.BRAND_LOGO_URL || '',
  tagline: `${feed.product} — ${cadenceLabel === 'every day' ? 'Daily' : 'Weekday'} Brief`,
  dateFull: formatDateFull(nowIST()),
  subjectDate: formatDayMon(nowIST()),
  editionLabel: sel.editionLabel,
  cadenceLabel,
  timeLabel: '08:00',
  tz: 'IST',
  byNumbers: sel.byNumbers,
  frontPage: sel.frontPage,
  sections: sel.sections,
  total: sel.total,
  unsubUrl: `${SITE}/api/unsubscribe?token=preview-token`,
  siteUrl: SITE,
};

const { subject, html } = renderDigestEmail(model);
const out = path.join(ROOT, 'email-preview.html');
await writeFile(out, html);

console.log('Data date:      ', feed.dataDate);
console.log('Feed items:     ', feed.counts.total, `(${feed.counts.movers} movers, ${feed.counts.filings} filings)`);
console.log('Edition:        ', sel.editionLabel);
console.log('Front page:     ', sel.frontPage.length, '| sections:', sel.sections.length, '| shown:', sel.total);
console.log('Subject:        ', subject);
console.log('Wrote:          ', out);
