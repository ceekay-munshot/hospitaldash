#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCompanies } from './lib/bse.mjs';

const RULES = [
  // ── HIGH-VALUE: LLM-extraction targets ──────────────────────────────
  {
    type: 'investor-presentation',
    priority: 'high',
    test: (cat, sub) =>
      /investor.*presentation/i.test(sub) ||
      (/presentation/i.test(sub) && !/transcript/i.test(sub) && /(earning|quarter|q[1-4]\b|fy\s*\d|h[12]\b|annual|nine.?month|half.?year)/i.test(sub)),
  },
  {
    type: 'concall-transcript',
    priority: 'high',
    test: (_cat, sub) => /transcript/i.test(sub),
  },
  {
    type: 'concall-audio',
    priority: 'high',
    test: (_cat, sub) => /audio.*(call|recording|webcast|conference)/i.test(sub),
  },
  {
    type: 'quarterly-result',
    priority: 'high',
    test: (cat) => cat === 'Result',
  },
  {
    type: 'annual-report',
    priority: 'high',
    test: (_cat, sub) => /annual report/i.test(sub) && !/reg\.?\s*34/i.test(sub),
  },
  {
    type: 'press-release',
    priority: 'high',
    test: (_cat, sub) => /press release|media release/i.test(sub),
  },
  {
    type: 'investor-meet-outcome',
    priority: 'medium',
    test: (_cat, sub) => /(investor|analyst).*meet.*outcome/i.test(sub),
  },

  // ── MEDIUM: contextually useful ─────────────────────────────────────
  {
    type: 'integrated-filing',
    priority: 'medium',
    test: (cat) => cat === 'Integrated Filing',
  },
  {
    type: 'analyst-meet-intimation',
    priority: 'low',
    test: (_cat, sub) => /(investor|analyst).*meet.*intimation/i.test(sub),
  },
  {
    type: 'board-meeting-intimation',
    priority: 'low',
    test: (cat, sub) => cat === 'Board Meeting' || /board meeting.*intimation/i.test(sub),
  },
  {
    type: 'board-meeting-outcome',
    priority: 'low',
    test: (_cat, sub) => /board meeting.*outcome|outcome.*board meeting/i.test(sub),
  },
  {
    type: 'agm-egm',
    priority: 'low',
    test: (cat) => cat === 'AGM/EGM',
  },
  {
    type: 'corp-action',
    priority: 'low',
    test: (cat) => /^corp\.?\s*action$/i.test((cat || '').trim()),
  },
  {
    type: 'insider-trading',
    priority: 'low',
    test: (cat) => /insider trading/i.test(cat || ''),
  },

  // ── LOW: noise ──────────────────────────────────────────────────────
  { type: 'credit-rating',         priority: 'low', test: (_c, s) => /credit rating/i.test(s) },
  { type: 'code-of-conduct',       priority: 'low', test: (_c, s) => /code of conduct/i.test(s) },
  { type: 'newspaper-advert',      priority: 'low', test: (_c, s) => /newspaper/i.test(s) },
  { type: 'esop',                  priority: 'low', test: (_c, s) => /\besop\b|employee stock|allotment of equity/i.test(s) },
  { type: 'scrutinizer-report',    priority: 'low', test: (_c, s) => /scrutinizer/i.test(s) },
  { type: 'shareholding-pattern',  priority: 'low', test: (_c, s) => /shareholding pattern/i.test(s) },
  { type: 'compliance',            priority: 'low', test: (_c, s) => /reg\.?\s*(39|74)|loss of certificate|duplicate certificate|compliance/i.test(s) },
  { type: 'new-listing',           priority: 'low', test: (cat) => cat === 'New Listing' },

  // ── Catch-all ───────────────────────────────────────────────────────
  { type: 'other', priority: 'low', test: () => true },
];

function classify(row) {
  const cat = row.CATEGORYNAME || '';
  const sub = `${row.NEWSSUB || ''} ${row.HEADLINE || ''}`;
  for (const r of RULES) {
    if (r.test(cat, sub)) return { docType: r.type, priority: r.priority };
  }
  return { docType: 'other', priority: 'low' };
}

function indianFiscalQuarter(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.getUTCMonth(); // 0-11
  const year = d.getUTCFullYear();
  let fy, q;
  if (month >= 3) {
    fy = (year + 1) % 100;
    q = Math.floor((month - 3) / 3) + 1;
  } else {
    fy = year % 100;
    q = 4;
  }
  return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

function quarterRange(fq) {
  const m = fq.match(/^FY(\d{2})-Q([1-4])$/);
  if (!m) return null;
  const fy = 2000 + Number(m[1]);
  const q = Number(m[2]);
  const ranges = {
    1: { from: `${fy - 1}-04-01`, to: `${fy - 1}-06-30`, calendar: `Apr–Jun ${fy - 1}` },
    2: { from: `${fy - 1}-07-01`, to: `${fy - 1}-09-30`, calendar: `Jul–Sep ${fy - 1}` },
    3: { from: `${fy - 1}-10-01`, to: `${fy - 1}-12-31`, calendar: `Oct–Dec ${fy - 1}` },
    4: { from: `${fy}-01-01`,     to: `${fy}-03-31`,     calendar: `Jan–Mar ${fy}` },
  };
  return { label: `Q${q} FY${m[1]}`, ...ranges[q] };
}

const HIGH = new Set(['investor-presentation', 'concall-transcript', 'concall-audio', 'quarterly-result', 'annual-report', 'press-release']);

function slim(r) {
  return {
    newsId: r.NEWSID,
    date: (r.DT_TM || r.NEWS_DT || '').slice(0, 10),
    subject: r.NEWSSUB,
    headline: r.HEADLINE,
    category: r.CATEGORYNAME,
    docType: r.docType,
    priority: r.priority,
    fiscalQuarter: r.fiscalQuarter,
    pdfUrl: r.PDF_URL || null,
    attachmentName: r.ATTACHMENTNAME || null,
  };
}

async function processCompany(company) {
  const path = `data/bse-${company.slug}.json`;
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const anns = raw.categories.announcements?.data || [];
  const arRows = raw.categories.annualReports?.data || [];

  const classified = anns.map((r) => {
    const { docType, priority } = classify(r);
    return { ...r, docType, priority, fiscalQuarter: indianFiscalQuarter(r.DT_TM || r.NEWS_DT) };
  });

  const byDocType = {};
  for (const r of classified) byDocType[r.docType] = (byDocType[r.docType] || 0) + 1;

  // Group by fiscal quarter
  const byQuarter = {};
  for (const r of classified) {
    const fq = r.fiscalQuarter;
    if (!fq) continue;
    if (!byQuarter[fq]) {
      byQuarter[fq] = {
        ...quarterRange(fq),
        fiscalQuarter: fq,
        priorityDocs: {},
        lowPriorityCount: 0,
      };
    }
    if (HIGH.has(r.docType)) {
      (byQuarter[fq].priorityDocs[r.docType] ??= []).push(slim(r));
    } else {
      byQuarter[fq].lowPriorityCount++;
    }
  }

  // Annual reports — already from a separate BSE endpoint; tag and add to all
  const arSlim = arRows.map((r) => ({
    newsId: r.NEWSID || r.ROWNUM || null,
    date: (r.DT_TM || r.News_submission_dt || r.AR_DT || '').slice(0, 10) || null,
    subject: r.NEWSSUB || r.NEWS_SUB || r.AR_TYPE || 'Annual Report',
    headline: r.HEADLINE || null,
    category: 'Annual Report (master)',
    docType: 'annual-report',
    priority: 'high',
    fiscalQuarter: null,
    pdfUrl: r.PDF_URL || (r.ATTACHMENTNAME ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${r.ATTACHMENTNAME}` : null),
    attachmentName: r.ATTACHMENTNAME || null,
    raw: r, // keep raw for now since AR schema varies
  }));

  // Sort quarter keys newest-first
  const sortedQuarterKeys = Object.keys(byQuarter).sort((a, b) => b.localeCompare(a));

  const out = {
    slug: company.slug,
    scripCode: company.scripCode,
    name: company.name,
    generatedAt: new Date().toISOString(),
    summary: {
      totalAnnouncements: classified.length,
      totalAnnualReportsMaster: arRows.length,
      byDocType,
      quartersCovered: sortedQuarterKeys.length,
      quarterRange: sortedQuarterKeys.length
        ? `${sortedQuarterKeys[sortedQuarterKeys.length - 1]} → ${sortedQuarterKeys[0]}`
        : null,
    },
    byQuarter: Object.fromEntries(sortedQuarterKeys.map((k) => [k, byQuarter[k]])),
    annualReports: arSlim,
    all: classified.map(slim),
  };

  const outPath = `data/docs/${company.slug}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2));
  return { slug: company.slug, total: classified.length, byDocType, quarters: sortedQuarterKeys.length };
}

async function run() {
  const companies = await loadCompanies();
  console.error(`Classifying docs for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}…\n`);
  const summaries = [];
  for (const c of companies) {
    const s = await processCompany(c);
    summaries.push(s);
    const high = ['investor-presentation', 'concall-transcript', 'concall-audio', 'quarterly-result', 'press-release']
      .map((t) => `${t.split('-').map((w) => w[0]).join('')}=${s.byDocType[t] || 0}`)
      .join(' ');
    console.error(`  ${c.slug.padEnd(22)} ${s.total} ann | ${s.quarters} quarters | ${high}`);
  }

  // Sector-level summary
  const sectorByType = {};
  for (const s of summaries) for (const [k, v] of Object.entries(s.byDocType)) sectorByType[k] = (sectorByType[k] || 0) + v;

  console.error('\n=== Sector-wide doc-type distribution ===');
  for (const [t, n] of Object.entries(sectorByType).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(5)}  ${t}`);
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
