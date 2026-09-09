// Pure, dependency-free selection: given a built feed and a subscriber's chosen
// categories, produce the front page, grouped sections, and by-the-numbers.
// Imported by the Worker (per-recipient render) and the preview script.

import { CATEGORIES, CATEGORY_KEYS, PALETTE } from './categories.mjs';

const FRONT_PAGE = 3;
const PER_SECTION = 5;

export function normalizeSections(sections) {
  if (!sections || sections === 'all' || (Array.isArray(sections) && sections.length === 0)) {
    return CATEGORY_KEYS.slice();
  }
  const wanted = (Array.isArray(sections) ? sections : [sections]).filter((k) => CATEGORY_KEYS.includes(k));
  return wanted.length ? wanted : CATEGORY_KEYS.slice();
}

export function editionLabel(wanted) {
  if (wanted.length === CATEGORY_KEYS.length) return 'Full Brief';
  return CATEGORIES.filter((c) => wanted.includes(c.key)).map((c) => c.label).join(', ');
}

// options: { sections, moverUrl } — moverUrl backfills mover links to the live site.
export function selectDigest(feed, options = {}) {
  const wanted = normalizeSections(options.sections);
  const all = (feed.items || [])
    .filter((i) => wanted.includes(i.category))
    .map((i) => (i.kind === 'mover' && !i.url && options.moverUrl ? { ...i, url: options.moverUrl } : i));

  const sorted = [...all].sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));

  // Front page = the top items, but at most one per company so the lead stories
  // read like a varied front page rather than five results in a row.
  const frontPage = [];
  const usedEntities = new Set();
  for (const i of sorted) {
    if (frontPage.length >= FRONT_PAGE) break;
    if (usedEntities.has(i.entity)) continue;
    frontPage.push(i);
    usedEntities.add(i.entity);
  }
  const frontIds = new Set(frontPage.map((i) => i.id));
  const rest = sorted.filter((i) => !frontIds.has(i.id));

  const sections = [];
  for (const c of CATEGORIES) {
    if (!wanted.includes(c.key)) continue;
    const items = rest.filter((i) => i.category === c.key).slice(0, PER_SECTION);
    if (items.length) sections.push({ key: c.key, label: c.label, color: c.color, items });
  }

  const shown = [...frontPage, ...sections.flatMap((s) => s.items)];
  const movers = shown.filter((i) => i.kind === 'mover');
  const positive = movers.filter((i) => i.status === 'positive').length;
  const negative = movers.filter((i) => i.status === 'negative').length;

  const counts = {};
  for (const i of shown) counts[i.category] = (counts[i.category] || 0) + 1;
  let busiest = null;
  let max = -1;
  for (const c of CATEGORIES) {
    if ((counts[c.key] || 0) > max) {
      max = counts[c.key] || 0;
      busiest = c;
    }
  }

  return {
    wanted,
    editionLabel: editionLabel(wanted),
    total: shown.length,
    frontPage,
    sections,
    byNumbers: {
      total: shown.length,
      positive,
      negative,
      busiestLabel: busiest ? busiest.label : '—',
      busiestColor: busiest ? busiest.color : PALETTE.ink,
    },
  };
}
