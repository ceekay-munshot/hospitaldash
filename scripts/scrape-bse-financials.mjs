#!/usr/bin/env node
// BSE financials scraper — pulls structured quarterly P&L from BSE's
// Comp_ResultsAlltypeNew endpoint (zero AI, zero quotas, works forever).
//
// Output: data/financials/<slug>.json
//   {
//     slug, scripCode, name,
//     fetchedAt,
//     quarterly: [
//       { period: "FY26-Q4", periodEnding: "2026-03-31", revenue, otherIncome,
//         totalIncome, totalExpenses, ebitda, depreciation, financeCost, pbt,
//         tax, pat, eps, ebitdaMargin, patMargin, type: "standalone"|"consolidated" }
//     ]
//   }
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchJSON, loadCompanies } from './lib/bse.mjs';

// BSE's "Quarterly Results" page hits this endpoint behind the scenes.
// typid: 1 = Standalone, 2 = Consolidated, 3 = Segment, 7 = Integrated
// flag: usually 'qtr' for quarterly
const ENDPOINTS = {
  consolidated: (scripcode) =>
    `https://api.bseindia.com/BseIndiaAPI/api/Comp_ResultsAlltypeNew/w?scripcode=${scripcode}&typeid=Q&PeriodFlag=Q&type=C`,
  standalone: (scripcode) =>
    `https://api.bseindia.com/BseIndiaAPI/api/Comp_ResultsAlltypeNew/w?scripcode=${scripcode}&typeid=Q&PeriodFlag=Q&type=S`,
};

// Fallback endpoint patterns to try if the primary ones don't work
const FALLBACK_ENDPOINTS = [
  (scripcode) => `https://api.bseindia.com/BseIndiaAPI/api/Comp_ResultsType/w?scripcode=${scripcode}&typeid=Q`,
  (scripcode) => `https://api.bseindia.com/BseIndiaAPI/api/EQReports_New/w?scripcode=${scripcode}&strdat=&strprdt=Quarterly`,
  (scripcode) => `https://api.bseindia.com/BseIndiaAPI/api/FinancialResults/w?scripcode=${scripcode}&typid=Q`,
];

function num(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/[,₹\s]/g, '').replace(/[()]/g, '-');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function indianFiscalQuarter(dateStr) {
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
  return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

// BSE Comp_Results responses use a variety of field names across endpoints.
// Map any encountered alias to our canonical field name.
const FIELD_ALIASES = {
  revenue: ['REVENUE_FROM_OPERATIONS', 'NetSales', 'Revenue', 'NET_SALES', 'OPERATING_INCOME', 'RevenueFromOperations'],
  otherIncome: ['OTHER_INCOME', 'OtherIncome'],
  totalIncome: ['TOTAL_INCOME', 'TotalIncome', 'TOTAL_REVENUE'],
  totalExpenses: ['TOTAL_EXPENSES', 'TotalExpenses', 'EXPENSES_TOTAL'],
  depreciation: ['DEPRECIATION', 'Depreciation', 'DEPRECIATION_AMORTISATION'],
  financeCost: ['FINANCE_COST', 'FinanceCost', 'INTEREST', 'Interest'],
  pbt: ['PROFIT_BEFORE_TAX', 'ProfitBeforeTax', 'PBT'],
  tax: ['TAX_EXPENSE', 'TaxExpense', 'CURRENT_TAX', 'Tax'],
  pat: ['PROFIT_AFTER_TAX', 'NetProfit', 'PROFIT_FOR_THE_PERIOD', 'NetProfitLoss', 'PAT', 'PROFIT_LOSS'],
  eps: ['EPS_BASIC', 'EPS', 'BasicEPS', 'EARNINGS_PER_SHARE'],
  period: ['END_DATE', 'PeriodEnding', 'QUARTER_END', 'PERIOD_END_DATE', 'EndDate', 'DT_TM'],
};

function lookupByAlias(row, canonical) {
  const aliases = FIELD_ALIASES[canonical] || [];
  // Case-insensitive lookup across all keys
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const found = keys.find((k) => k.toLowerCase() === alias.toLowerCase());
    if (found && row[found] != null && row[found] !== '') return row[found];
  }
  return null;
}

function normalizeRow(row, type) {
  const periodRaw = lookupByAlias(row, 'period');
  const periodEnding = periodRaw ? String(periodRaw).slice(0, 10) : null;
  const revenue = num(lookupByAlias(row, 'revenue'));
  const otherIncome = num(lookupByAlias(row, 'otherIncome'));
  const totalIncome = num(lookupByAlias(row, 'totalIncome')) ?? ((revenue ?? 0) + (otherIncome ?? 0) || null);
  const totalExpenses = num(lookupByAlias(row, 'totalExpenses'));
  const depreciation = num(lookupByAlias(row, 'depreciation'));
  const financeCost = num(lookupByAlias(row, 'financeCost'));
  const pbt = num(lookupByAlias(row, 'pbt'));
  const tax = num(lookupByAlias(row, 'tax'));
  const pat = num(lookupByAlias(row, 'pat'));
  const eps = num(lookupByAlias(row, 'eps'));

  // EBITDA = PBT + Finance cost + Depreciation (standard derivation)
  let ebitda = null;
  if (pbt != null) {
    ebitda = pbt + (depreciation || 0) + (financeCost || 0);
  } else if (totalIncome != null && totalExpenses != null) {
    // Fallback: operating profit + d&a
    ebitda = totalIncome - totalExpenses + (depreciation || 0) + (financeCost || 0);
  }
  const ebitdaMargin = ebitda != null && revenue ? Number(((ebitda / revenue) * 100).toFixed(2)) : null;
  const patMargin = pat != null && revenue ? Number(((pat / revenue) * 100).toFixed(2)) : null;

  return {
    period: indianFiscalQuarter(periodEnding),
    periodEnding,
    revenue,
    otherIncome,
    totalIncome,
    totalExpenses,
    depreciation,
    financeCost,
    pbt,
    tax,
    pat,
    eps,
    ebitda,
    ebitdaMargin,
    patMargin,
    type,
    raw: row,
  };
}

function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Table)) return payload.Table;
  if (Array.isArray(payload.Data)) return payload.Data;
  if (Array.isArray(payload.data)) return payload.data;
  if (typeof payload === 'object') {
    for (const v of Object.values(payload)) if (Array.isArray(v) && v.length > 0) return v;
  }
  return [];
}

async function fetchOne(scripcode, urlBuilder, label) {
  const url = urlBuilder(scripcode);
  try {
    const payload = await fetchJSON(url, { maxAttempts: 3 });
    const rows = extractRows(payload);
    return { ok: true, url, rows, label, samplePayloadKeys: rows[0] ? Object.keys(rows[0]) : [] };
  } catch (e) {
    return { ok: false, url, error: e.message, label };
  }
}

async function processCompany(company) {
  const { scripCode, slug, name } = company;
  console.error(`\n[${slug}] (${scripCode})`);

  // Try consolidated first (preferred for hospital groups), then standalone, then fallbacks
  const tries = [
    { label: 'consolidated', url: ENDPOINTS.consolidated },
    { label: 'standalone', url: ENDPOINTS.standalone },
    ...FALLBACK_ENDPOINTS.map((u, i) => ({ label: `fallback-${i + 1}`, url: u })),
  ];

  const allRows = [];
  const attemptsLog = [];
  for (const { label, url } of tries) {
    const res = await fetchOne(scripCode, url, label);
    attemptsLog.push({ label, ok: res.ok, rowCount: res.rows?.length || 0, error: res.error, urlSample: res.url, sampleKeys: res.samplePayloadKeys });
    if (res.ok && res.rows.length > 0) {
      console.error(`  ✓ ${label}: ${res.rows.length} rows (keys: ${res.samplePayloadKeys.slice(0, 5).join(', ')}…)`);
      for (const row of res.rows) allRows.push({ ...row, _sourceLabel: label });
    } else if (res.ok) {
      console.error(`  · ${label}: 200 OK but no rows`);
    } else {
      console.error(`  · ${label}: ${res.error}`);
    }
  }

  // Normalize all rows. Prefer consolidated for any given period.
  const byPeriod = new Map();
  for (const row of allRows) {
    const type = row._sourceLabel?.includes('consolidated') ? 'consolidated' : 'standalone';
    const normalized = normalizeRow(row, type);
    if (!normalized.period) continue;

    const existing = byPeriod.get(normalized.period);
    if (!existing) {
      byPeriod.set(normalized.period, normalized);
    } else if (existing.type !== 'consolidated' && normalized.type === 'consolidated') {
      byPeriod.set(normalized.period, normalized);
    }
  }

  const quarterly = [...byPeriod.values()].sort((a, b) =>
    String(a.periodEnding).localeCompare(String(b.periodEnding))
  );

  // Strip the raw payload to keep file size reasonable
  const clean = quarterly.map(({ raw, ...rest }) => rest);

  const out = {
    slug,
    scripCode,
    name,
    fetchedAt: new Date().toISOString(),
    quarterCount: clean.length,
    quarterly: clean,
    attempts: attemptsLog,
  };

  const path = `data/financials/${slug}.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2));
  console.error(`  → ${path} (${clean.length} quarters)`);

  return { slug, quarters: clean.length, periods: clean.map((q) => q.period) };
}

async function run() {
  const companies = await loadCompanies();
  console.error(`Fetching BSE structured quarterly financials for ${companies.length} cos…`);
  const summary = [];
  for (const c of companies) {
    try {
      summary.push(await processCompany(c));
    } catch (e) {
      console.error(`  TOP-LEVEL FAIL for ${c.slug}: ${e.message}`);
      summary.push({ slug: c.slug, quarters: 0, error: e.message });
    }
  }
  console.error('\n=== Summary ===');
  for (const s of summary) {
    console.error(`  ${s.slug.padEnd(22)} ${String(s.quarters).padStart(3)} quarters ${s.periods ? `(${s.periods[0]} → ${s.periods[s.periods.length - 1]})` : ''}`);
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
