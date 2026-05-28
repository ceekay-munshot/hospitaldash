#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCompanies } from './lib/bse.mjs';
import { compareQuarters, stats } from './lib/metric-merge.mjs';

// Metrics for which "higher = better" (used for ranking direction).
const HIGHER_IS_BETTER = new Set([
  'numberOfHospitals',
  'bedCapacity',
  'operationalBeds',
  'bedsUnderDevelopment',
  'occupancyRate',
  'ipVolume',
  'opVolume',
  'arpob',
  'arpp',
  'revenue',
  'ebitda',
  'ebitdaMargin',
  'pat',
  'patMargin',
  'capexAnnounced',
  'revenueGrowthYoy',
  'revenueCagr3yr',
  'roce',
  'revenuePerBedYearly',
  'ebitdaPerBedYearly',
  'ebitdaTtmCr',
  'bedTurnoverYearly',
  'bedActivationPct',
]);
const LOWER_IS_BETTER = new Set([
  'alos',
  'netDebt',
  'netDebtToEbitda',
  'evToEbitdaAnnualised',
  'peAnnualised',
]);

const METRIC_META = {
  numberOfHospitals: { label: 'Hospitals', unit: 'count', section: 'network' },
  bedCapacity: { label: 'Bed capacity', unit: 'count', section: 'network' },
  operationalBeds: { label: 'Operational beds', unit: 'count', section: 'network' },
  bedsUnderDevelopment: { label: 'Beds under development', unit: 'count', section: 'network' },
  newHospitalsPlanned: { label: 'New hospitals planned', unit: 'count', section: 'network' },
  occupancyRate: { label: 'Occupancy', unit: '%', section: 'operations' },
  alos: { label: 'ALOS', unit: 'days', section: 'operations' },
  ipVolume: { label: 'IP volume', unit: 'admissions', section: 'operations' },
  opVolume: { label: 'OP volume', unit: 'visits', section: 'operations' },
  arpob: { label: 'ARPOB', unit: 'INR/day', section: 'revenueQuality' },
  arpp: { label: 'ARPP', unit: 'INR/patient', section: 'revenueQuality' },
  revenue: { label: 'Revenue', unit: 'INR Cr', section: 'financials' },
  ebitda: { label: 'EBITDA', unit: 'INR Cr', section: 'financials' },
  ebitdaMargin: { label: 'EBITDA margin', unit: '%', section: 'profitability' },
  pat: { label: 'PAT', unit: 'INR Cr', section: 'financials' },
  patMargin: { label: 'PAT margin', unit: '%', section: 'profitability', derived: true },
  netDebt: { label: 'Net debt', unit: 'INR Cr', section: 'balanceSheet' },
  capexAnnounced: { label: 'Capex announced', unit: 'INR Cr', section: 'expansion' },
  revenueGrowthYoy: { label: 'Revenue YoY', unit: '%', section: 'profitability' },
  revenueCagr3yr: { label: 'Revenue CAGR (3yr)', unit: '%', section: 'profitability', derived: true },
  roce: { label: 'ROCE', unit: '%', section: 'profitability' },
  // derived
  revenuePerBedYearly: { label: 'Revenue / bed (annualised)', unit: 'INR/bed', section: 'profitability', derived: true },
  ebitdaPerBedYearly: { label: 'EBITDA / bed (annualised)', unit: 'INR/bed', section: 'profitability', derived: true },
  ebitdaTtmCr: { label: 'EBITDA (TTM)', unit: 'INR Cr', section: 'financials', derived: true },
  netDebtToEbitda: { label: 'Net debt / EBITDA', unit: 'x', section: 'balanceSheet', derived: true },
  bedTurnoverYearly: { label: 'Bed turnover (annualised)', unit: 'admits/bed/yr', section: 'operations', derived: true },
  bedActivationPct: { label: 'Bed activation', unit: '%', section: 'network', derived: true },
  enterpriseValueCr: { label: 'Enterprise value', unit: 'INR Cr', section: 'valuation', derived: true },
  evToEbitdaAnnualised: { label: 'EV / EBITDA', unit: 'x', section: 'valuation', derived: true },
  evPerBedCr: { label: 'EV / bed', unit: 'INR Cr/bed', section: 'valuation', derived: true },
  evPerBedLakhs: { label: 'EV / bed', unit: '₹ lakh/bed', section: 'valuation', derived: true },
  peAnnualised: { label: 'P/E (annualised)', unit: 'x', section: 'valuation', derived: true },
};

const METRIC_KEYS = Object.keys(METRIC_META);
const DERIVED_KEYS = Object.keys(METRIC_META).filter((k) => METRIC_META[k].derived);
const BASE_KEYS = METRIC_KEYS.filter((k) => !METRIC_META[k].derived);

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function metricValueFor(quarterData, key) {
  if (!quarterData) return null;
  if (DERIVED_KEYS.includes(key)) {
    return quarterData.derived?.[key] ?? null;
  }
  return quarterData.metrics?.[key]?.value ?? null;
}

function rankings(byCompanyForMetric, key) {
  const entries = Object.entries(byCompanyForMetric).filter(([, v]) => v != null);
  const dir = LOWER_IS_BETTER.has(key) ? 1 : -1;
  entries.sort(([, a], [, b]) => dir * (a - b)); // best first
  return entries.map(([slug, value], i) => ({ slug, value, rank: i + 1 }));
}

async function run() {
  const companies = await loadCompanies();
  const cos = [];
  for (const c of companies) {
    const m = await loadJson(`data/metrics/${c.slug}.json`);
    if (m) cos.push({ company: c, metrics: m });
  }

  // Universe of quarters across all companies
  const allQuarters = new Set();
  for (const { metrics } of cos) {
    for (const fq of Object.keys(metrics.quarters || {})) allQuarters.add(fq);
  }
  const sortedQuarters = [...allQuarters].sort(compareQuarters);

  // ── byCompany ─────────────────────────────────────────────────────────
  const byCompany = {};
  for (const { company, metrics } of cos) {
    const quarters = {};
    for (const fq of sortedQuarters) {
      const qd = metrics.quarters[fq];
      if (!qd) continue;
      const flat = {};
      for (const k of METRIC_KEYS) {
        const v = metricValueFor(qd, k);
        if (v != null) flat[k] = v;
      }
      quarters[fq] = {
        label: qd.label,
        calendar: qd.calendar,
        metrics: flat,
        sources: qd.sourceExtractions.map((s) => ({
          docType: s.docType,
          date: s.date,
          pdfUrl: s.pdfUrl,
        })),
      };
    }
    byCompany[company.slug] = {
      slug: company.slug,
      name: company.name,
      shortName: company.shortName,
      scripCode: company.scripCode,
      ticker: metrics.ticker,
      sector: metrics.sector,
      industry: metrics.industry,
      latestQuote: metrics.latestQuote,
      coverage: metrics.coverage,
      quarters,
    };
  }

  // ── byMetric: metric → quarter → company → value ──────────────────────
  const byMetric = {};
  for (const key of METRIC_KEYS) {
    const byQuarter = {};
    for (const fq of sortedQuarters) {
      const map = {};
      for (const { company } of cos) {
        const v = metricValueFor(byCompany[company.slug]?.quarters?.[fq], key);
        if (v != null) map[company.slug] = v;
      }
      if (Object.keys(map).length) byQuarter[fq] = map;
    }
    byMetric[key] = {
      ...METRIC_META[key],
      higherIsBetter: !LOWER_IS_BETTER.has(key),
      byQuarter,
    };
  }

  // For byMetric, the flat structure above puts the *whole* quarter row.
  // Re-correct: metricValueFor expects a quarter object — adjust to read .metrics[key] from flat
  for (const key of METRIC_KEYS) {
    const byQuarter = {};
    for (const fq of sortedQuarters) {
      const map = {};
      for (const { company } of cos) {
        const v = byCompany[company.slug]?.quarters?.[fq]?.metrics?.[key];
        if (v != null) map[company.slug] = v;
      }
      if (Object.keys(map).length) byQuarter[fq] = map;
    }
    byMetric[key].byQuarter = byQuarter;
  }

  // ── Rankings & aggregates per quarter ─────────────────────────────────
  const rankingsByQuarter = {};
  const aggregatesByQuarter = {};
  for (const fq of sortedQuarters) {
    rankingsByQuarter[fq] = {};
    aggregatesByQuarter[fq] = {};
    for (const key of METRIC_KEYS) {
      const m = byMetric[key].byQuarter[fq];
      if (!m || Object.keys(m).length === 0) continue;
      rankingsByQuarter[fq][key] = rankings(m, key);
      aggregatesByQuarter[fq][key] = stats(Object.values(m));
    }
  }

  // ── Latest quarter snapshot — convenience for dashboard headline view ─
  const latestQuarter = sortedQuarters[sortedQuarters.length - 1] || null;

  const out = {
    generatedAt: new Date().toISOString(),
    companies: cos.map(({ company, metrics }) => ({
      slug: company.slug,
      name: company.name,
      shortName: company.shortName,
      ticker: metrics.ticker,
      latestQuote: metrics.latestQuote,
    })),
    quarters: sortedQuarters,
    latestQuarter,
    metricMeta: METRIC_META,
    byCompany,
    byMetric,
    rankings: rankingsByQuarter,
    sectorAggregates: aggregatesByQuarter,
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/sector.json', JSON.stringify(out, null, 2));

  console.error(`\nBuilt data/sector.json`);
  console.error(`  companies: ${cos.length}`);
  console.error(`  quarters: ${sortedQuarters.length} (${sortedQuarters[0] || '—'} → ${latestQuarter || '—'})`);
  console.error(`  metrics tracked: ${METRIC_KEYS.length} (${DERIVED_KEYS.length} derived)`);

  // Coverage matrix log: how many companies have each metric at the latest quarter
  if (latestQuarter) {
    console.error(`\n=== Coverage at latest quarter (${latestQuarter}) ===`);
    for (const key of METRIC_KEYS) {
      const m = byMetric[key].byQuarter[latestQuarter];
      const n = m ? Object.keys(m).length : 0;
      const pct = ((n / cos.length) * 100).toFixed(0);
      console.error(`  ${key.padEnd(28)} ${String(n).padStart(2)}/${cos.length} cos (${pct}%)`);
    }
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
