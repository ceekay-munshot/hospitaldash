#!/usr/bin/env node
// BSE financials scraper — parses the quarterly-result PDFs we've already
// classified, extracting Revenue/EBITDA/PAT etc. via Schedule III regex
// patterns. NO API endpoints to discover, NO LLM, NO quotas.
//
// Output: data/financials/<slug>.json — one row per quarter:
//   { period: "FY26-Q4", periodEnding, revenue, ebitda, ebitdaMargin,
//     pat, patMargin, depreciation, financeCost, pbt, eps, type, source }
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { loadCompanies } from './lib/bse.mjs';
import { downloadPdf } from './lib/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// ── Number parsing (handles Indian comma format, parentheses for negative) ──
function parseNum(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (s === '' || s === '-' || s === '–' || /^N\/?A$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,₹\s]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Multiplier to convert raw values into ₹ Crore
function detectScaleToCrore(text) {
  const head = text.slice(0, 3000);
  if (/in\s+Lakh|in\s+Lacs/i.test(head)) return 0.01; // lakh → Cr (1 Cr = 100 lakh)
  if (/in\s+Million|in\s+Mio\.?\b/i.test(head)) return 0.1; // mn → Cr
  if (/in\s+Billion|in\s+Bn\.?\b/i.test(head)) return 100;
  if (/in\s+Thousand/i.test(head)) return 0.00001;
  // default: Crore
  return 1;
}

// Indian fiscal quarter from filing/period date
function indianFiscalQuarter(dateStr, isFiling = false) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  let fy, q;
  if (month >= 3) {
    fy = (year + 1) % 100;
    q = Math.floor((month - 3) / 3) + 1;
  } else {
    fy = year % 100;
    q = 4;
  }
  if (isFiling) {
    // Filings typically report previous quarter
    q -= 1;
    if (q === 0) {
      q = 4;
      fy = fy === 0 ? 99 : fy - 1;
    }
  }
  return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

// ── Pattern library ────────────────────────────────────────────────────
// First numeric occurrence after each phrase (within 200 chars). Use
// non-greedy match. Numbers can have commas, decimals, parentheses.
const NUMBER_RE_SOURCE = '\\(?[\\-–]?[\\d,]+\\.?\\d*\\)?';

function buildPattern(phrase) {
  return new RegExp(`${phrase}[\\s\\S]{0,200}?(${NUMBER_RE_SOURCE})`, 'i');
}

const METRIC_PATTERNS = {
  revenue: [
    'Revenue from operations',
    'Income from operations',
    'Total revenue from operations',
    'Total income from operations',
  ],
  otherIncome: ['Other income'],
  totalIncome: ['Total income', 'Total revenue'],
  totalExpenses: ['Total expenses'],
  depreciation: [
    'Depreciation and amortisation',
    'Depreciation, amortisation',
    'Depreciation/amortisation',
    'Depreciation expense',
  ],
  financeCost: ['Finance cost', 'Finance costs', 'Interest expense'],
  pbt: [
    'Profit before tax',
    'Profit/\\(loss\\) before tax',
    'Profit/loss before tax',
    'Profit/\\(Loss\\) before tax',
  ],
  tax: ['Tax expense', 'Total tax expense'],
  pat: [
    'Profit for the period',
    'Profit/\\(loss\\) for the period',
    'Profit for the year',
    'Profit/\\(loss\\) for the year',
    'Net profit for the period',
    'Net Profit',
  ],
  eps: ['Earnings per share', 'Basic earnings per share', 'EPS \\(Basic\\)', 'EPS \\(\\u20b9\\)'],
};

function findFirstMetric(text, phrases) {
  for (const phrase of phrases) {
    const re = buildPattern(phrase);
    const m = text.match(re);
    if (!m) continue;
    const n = parseNum(m[1]);
    if (n != null && Math.abs(n) > 0.001) {
      return { value: n, matchedPhrase: phrase };
    }
  }
  return null;
}

async function parseQuarterlyPdf(filing) {
  const { buf } = await downloadPdf(filing.pdfUrl);
  const parsed = await pdfParse(buf);
  const text = parsed.text || '';
  const scale = detectScaleToCrore(text);

  const extracted = {};
  const matched = {};
  for (const [key, phrases] of Object.entries(METRIC_PATTERNS)) {
    const r = findFirstMetric(text, phrases);
    if (r) {
      extracted[key] = key === 'eps' ? r.value : r.value * scale;
      matched[key] = r.matchedPhrase;
    } else {
      extracted[key] = null;
    }
  }

  // Derive EBITDA = PBT + Depreciation + Finance cost
  const ebitda =
    extracted.pbt != null
      ? extracted.pbt + (extracted.depreciation ?? 0) + (extracted.financeCost ?? 0)
      : null;
  const ebitdaMargin =
    ebitda != null && extracted.revenue ? Number(((ebitda / extracted.revenue) * 100).toFixed(2)) : null;
  const patMargin =
    extracted.pat != null && extracted.revenue
      ? Number(((extracted.pat / extracted.revenue) * 100).toFixed(2))
      : null;

  return {
    revenue: round(extracted.revenue),
    otherIncome: round(extracted.otherIncome),
    totalIncome: round(extracted.totalIncome),
    totalExpenses: round(extracted.totalExpenses),
    depreciation: round(extracted.depreciation),
    financeCost: round(extracted.financeCost),
    pbt: round(extracted.pbt),
    tax: round(extracted.tax),
    pat: round(extracted.pat),
    eps: extracted.eps,
    ebitda: round(ebitda),
    ebitdaMargin,
    patMargin,
    pdfScale: scale,
    matchedPhrases: matched,
    textPreview: text.slice(0, 300).replace(/\s+/g, ' '),
  };
}

function round(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Number(n.toFixed(2));
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function processCompany(company) {
  const { slug, scripCode, name } = company;
  console.error(`\n[${slug}] (${scripCode})`);

  const docsFile = await loadJson(`data/docs/${slug}.json`);
  if (!docsFile) {
    console.error(`  no docs file — skipping`);
    return { slug, quarters: 0, error: 'no docs file' };
  }

  // Load existing financials cache (avoid re-parsing already-done PDFs)
  const existingPath = `data/financials/${slug}.json`;
  const existing = (await loadJson(existingPath)) || {
    slug, scripCode, name, quarterly: [], byNewsId: {},
  };
  if (!existing.byNewsId) existing.byNewsId = {};

  // Collect ALL quarterly-result filings across quarters
  const candidates = [];
  for (const fq of Object.keys(docsFile.byQuarter || {})) {
    const qDocs = docsFile.byQuarter[fq]?.priorityDocs?.['quarterly-result'] || [];
    for (const d of qDocs) {
      if (d.pdfUrl) candidates.push({ ...d, filingQuarter: fq });
    }
  }

  // De-dup by newsId; newest first
  const seen = new Set();
  const unique = [];
  for (const c of candidates.sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    const id = String(c.newsId);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(c);
  }

  console.error(`  ${unique.length} quarterly-result PDFs to parse (${Object.keys(existing.byNewsId).length} cached)`);

  let parsed = 0, errors = 0, skipped = 0;
  for (const filing of unique) {
    const newsId = String(filing.newsId);
    if (existing.byNewsId[newsId]?.revenue != null) {
      skipped++;
      continue;
    }
    const reportingQuarter = indianFiscalQuarter(filing.date, true);
    process.stderr.write(`    [${reportingQuarter || '?'}] ${(filing.subject || '').slice(0, 60)} … `);
    try {
      const result = await parseQuarterlyPdf(filing);
      const periodEnding = guessPeriodEndingFromQuarter(reportingQuarter);
      existing.byNewsId[newsId] = {
        newsId,
        filingDate: filing.date,
        period: reportingQuarter,
        periodEnding,
        pdfUrl: filing.pdfUrl,
        ...result,
        parsedAt: new Date().toISOString(),
      };
      parsed++;
      const nonNull = ['revenue', 'pbt', 'pat'].filter((k) => result[k] != null).length;
      console.error(`OK rev=${result.revenue ?? '—'} ebitda=${result.ebitda ?? '—'} pat=${result.pat ?? '—'} (${nonNull}/3 core)`);
    } catch (e) {
      existing.byNewsId[newsId] = {
        newsId,
        filingDate: filing.date,
        period: reportingQuarter,
        pdfUrl: filing.pdfUrl,
        error: e.message,
        parsedAt: new Date().toISOString(),
      };
      errors++;
      console.error(`FAIL ${e.message.slice(0, 80)}`);
    }
  }

  // Build quarterly time-series: for each period, pick the best parsed row
  // (most recent filing date wins, ties broken by more non-null metrics)
  const byPeriod = new Map();
  for (const row of Object.values(existing.byNewsId)) {
    if (!row.period || row.revenue == null) continue;
    const cur = byPeriod.get(row.period);
    if (!cur) {
      byPeriod.set(row.period, row);
    } else {
      const curScore = ['revenue', 'pbt', 'pat'].filter((k) => cur[k] != null).length;
      const newScore = ['revenue', 'pbt', 'pat'].filter((k) => row[k] != null).length;
      if (newScore > curScore || (newScore === curScore && row.filingDate > cur.filingDate)) {
        byPeriod.set(row.period, row);
      }
    }
  }

  const quarterly = [...byPeriod.values()]
    .map((r) => ({
      period: r.period,
      periodEnding: r.periodEnding,
      revenue: r.revenue,
      otherIncome: r.otherIncome,
      totalIncome: r.totalIncome,
      depreciation: r.depreciation,
      financeCost: r.financeCost,
      pbt: r.pbt,
      tax: r.tax,
      pat: r.pat,
      eps: r.eps,
      ebitda: r.ebitda,
      ebitdaMargin: r.ebitdaMargin,
      patMargin: r.patMargin,
      type: 'derived-from-pdf',
      sourceNewsId: r.newsId,
      sourcePdfUrl: r.pdfUrl,
    }))
    .sort((a, b) => String(a.periodEnding).localeCompare(String(b.periodEnding)));

  existing.quarterly = quarterly;
  existing.quarterCount = quarterly.length;
  existing.lastBuiltAt = new Date().toISOString();

  await mkdir(dirname(existingPath), { recursive: true });
  await writeFile(existingPath, JSON.stringify(existing, null, 2));

  console.error(`  → ${existingPath}: +${parsed} parsed, ${errors} errors, ${skipped} cached, ${quarterly.length} unique quarters`);
  return { slug, quarters: quarterly.length, parsed, errors, periods: quarterly.map((q) => q.period) };
}

function guessPeriodEndingFromQuarter(fq) {
  const m = /^FY(\d{2})-Q([1-4])$/.exec(fq || '');
  if (!m) return null;
  const fy = 2000 + Number(m[1]);
  const q = Number(m[2]);
  const ends = { 1: `${fy - 1}-06-30`, 2: `${fy - 1}-09-30`, 3: `${fy - 1}-12-31`, 4: `${fy}-03-31` };
  return ends[q] || null;
}

async function run() {
  const companies = await loadCompanies();
  console.error(`Parsing quarterly-result PDFs for ${companies.length} cos…`);

  const summary = [];
  for (const c of companies) {
    try {
      summary.push(await processCompany(c));
    } catch (e) {
      console.error(`  TOP-LEVEL FAIL for ${c.slug}: ${e.message}`);
      summary.push({ slug: c.slug, quarters: 0, error: e.message });
    }
  }

  console.error('\n=== Financials summary ===');
  for (const s of summary) {
    const range = s.periods?.length
      ? `${s.periods[0]} → ${s.periods[s.periods.length - 1]}`
      : '—';
    console.error(
      `  ${s.slug.padEnd(22)} ${String(s.quarters).padStart(3)} quarters (+${s.parsed || 0} parsed, ${s.errors || 0} errors) · ${range}`
    );
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
