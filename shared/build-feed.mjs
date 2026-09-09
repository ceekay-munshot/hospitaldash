// Node-only builder: reads the committed data/ JSON and produces a compact,
// deploy-friendly digest feed (movers + recent priority filings), normalized
// into newspaper-ready items. Imported by dashboard/prepare.mjs at build time
// and by scripts/preview-email.mjs. Not imported by the Worker.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CATEGORIES, CATEGORY_BY_KEY, DOCTYPE_TO_CATEGORY, DOCTYPE_LABEL,
  STATUS, cleanSubject, isoDate,
} from './categories.mjs';

const PRODUCT = 'Hospital Sector Dashboard';
const MOVER_MIN_PCT = 0.75; // |%change| to count as a notable mover
const FLAT_BAND = 0.15; // within ±this% counts as "flat"
const FILING_WINDOW_DAYS = 75; // keep filings within N days of the newest filing
const MAX_FILINGS = 60;
const MAX_MOVERS = 12;

// ── number formatting (Indian grouping) ───────────────────────────────────
function indianGroup(numStr) {
  const s = String(numStr);
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  if (digits.length <= 3) return (neg ? '-' : '') + digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + rest + ',' + last3;
}
function fmtPrice(n) {
  const cleaned = Number(n).toFixed(2).replace(/\.?0+$/, '');
  const [ip, dp] = cleaned.split('.');
  return dp ? indianGroup(ip) + '.' + dp : indianGroup(ip);
}
function fmtCr(n) {
  return indianGroup(String(Math.round(Number(n))));
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

// ── movers, from sector.json latestQuote ──────────────────────────────────
function buildMovers(sector) {
  const items = [];
  let newest = '';
  for (const c of sector.companies || []) {
    const co = sector.byCompany?.[c.slug];
    const q = co?.latestQuote;
    if (!q || q.changePct == null) continue;
    const pct = Number(q.changePct);
    if (Math.abs(pct) < MOVER_MIN_PCT) continue;
    const status = pct > FLAT_BAND ? 'positive' : pct < -FLAT_BAND ? 'negative' : 'neutral';
    const date = q.date || co.latestQuote?.date || '';
    if (date > newest) newest = date;
    const sign = pct >= 0 ? '+' : '';
    const mcap = q.marketCapCr != null ? `market cap ₹${fmtCr(q.marketCapCr)} Cr` : '';
    const phrase = status === 'positive' ? 'sector gainer' : status === 'negative' ? 'sector decliner' : 'little changed';
    items.push({
      id: 'mv-' + c.slug,
      kind: 'mover',
      category: 'market',
      color: CATEGORY_BY_KEY.market.color,
      entity: co.name || c.name,
      entityShort: c.shortName || co.name || c.name,
      scripCode: c.scripCode || co.scripCode || '',
      headline: `${sign}${pct.toFixed(2)}% to ₹${fmtPrice(q.price)}`,
      summary: [mcap, phrase].filter(Boolean).join(' · '),
      status,
      statusLabel: STATUS[status].label,
      source: 'BSE',
      url: null, // Worker fills with the live dashboard origin
      date,
      score: Math.abs(pct) * 12 + 8,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, MAX_MOVERS), newest };
}

// ── one filing → normalized item (or null if not worth emailing) ──────────
function filingItem(it, company, newestFiling) {
  const cat = DOCTYPE_TO_CATEGORY[it.docType];
  if (!cat) return null; // low-signal docType — drop
  if (it.priority !== 'high' && it.priority !== 'medium') return null;
  if (!it.date) return null;

  const daysOld = Math.max(0, daysBetween(it.date, newestFiling));
  const label = DOCTYPE_LABEL[it.docType] || 'Filing';
  const head = cleanSubject(it.headline || '');
  const subj = cleanSubject(it.subject || '');
  const generic = (s) => !s || s.length < 4 || /^as per annexure/i.test(s);
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  let title;
  let summary;
  if (cat === 'results') {
    // The filing's fiscalQuarter is the period it was FILED in, not the period
    // the results cover — so never derive the quarter from it. Use a clean,
    // accurate label and let the real subject carry the specifics.
    title = label;
    const detail = [subj, head].filter((s) => !generic(s)).sort((a, b) => b.length - a.length)[0];
    summary = detail ? trunc(detail, 120) : `${label} filed with BSE`;
  } else {
    // Prefer the human note (headline) as the concise title, keep the other line
    // as the one-liner summary.
    const cands = [head, subj].filter((s) => !generic(s));
    const t0 = cands[0] || label;
    title = trunc(t0, 90);
    const s0 = cands.find((c) => c !== t0);
    summary = trunc(s0 || `${label} filed with BSE`, 120);
  }

  const base = it.priority === 'high' ? 20 : 9;
  const recency = Math.max(0, 16 - daysOld * 0.22);
  const typeBoost = cat === 'results' ? 8 : cat === 'ratings' ? 5 : cat === 'investor' ? 3 : 0;

  return {
    id: 'fl-' + (it.newsId || `${company.slug}-${it.date}-${it.docType}`),
    kind: 'filing',
    category: cat,
    color: CATEGORY_BY_KEY[cat].color,
    entity: company.name,
    entityShort: company.shortName || company.name,
    scripCode: company.scripCode || '',
    headline: title,
    summary,
    status: null,
    statusLabel: null,
    source: 'BSE',
    url: it.pdfUrl || null,
    date: it.date,
    docType: it.docType,
    score: base + recency + typeBoost,
  };
}

async function buildFilings(dataDir, companyBySlug) {
  const docsDir = path.join(dataDir, 'docs');
  let files = [];
  try {
    files = (await readdir(docsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { items: [], newest: '' };
  }

  const raw = [];
  let newest = '';
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(await readFile(path.join(docsDir, f), 'utf8'));
    } catch {
      continue;
    }
    const slug = doc.slug || f.replace(/\.json$/, '');
    const company = companyBySlug[slug] || { slug, name: doc.name || slug, shortName: doc.name || slug, scripCode: doc.scripCode };
    for (const it of doc.all || []) {
      if (it.date && it.date > newest) newest = it.date;
      raw.push({ it, company });
    }
  }
  if (!newest) return { items: [], newest: '' };

  const cutoff = isoDate(new Date(new Date(newest + 'T00:00:00Z').getTime() - FILING_WINDOW_DAYS * 86400000));
  const items = [];
  for (const { it, company } of raw) {
    if (it.date < cutoff) continue;
    const norm = filingItem(it, company, newest);
    if (norm) items.push(norm);
  }
  // de-dup by id AND by content (same company filing the same-titled doc twice,
  // e.g. a result and its revision) — keep the highest-scoring copy.
  const byKey = new Map();
  for (const i of items) {
    const key = `${i.entity}|${i.category}|${i.headline}`;
    const prev = byKey.get(key);
    if (!prev || prev.score < i.score) byKey.set(key, i);
  }
  const deduped = [...byKey.values()].sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return { items: deduped.slice(0, MAX_FILINGS), newest };
}

export async function buildFeed(dataDir) {
  const sector = JSON.parse(await readFile(path.join(dataDir, 'sector.json'), 'utf8'));
  const companyBySlug = {};
  for (const c of sector.companies || []) companyBySlug[c.slug] = c;

  const movers = buildMovers(sector);
  const filings = await buildFilings(dataDir, companyBySlug);

  const dataDate = [movers.newest, filings.newest].filter(Boolean).sort().pop() || isoDate(new Date());
  const items = [...movers.items, ...filings.items];

  return {
    product: PRODUCT,
    builtAt: new Date().toISOString(),
    dataDate,
    categories: CATEGORIES,
    counts: {
      total: items.length,
      movers: movers.items.length,
      filings: filings.items.length,
    },
    items,
  };
}
