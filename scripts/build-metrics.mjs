#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCompanies } from './lib/bse.mjs';
import {
  normalizeQuarter,
  quarterRange,
  compareQuarters,
  pickBestForMetric,
  deriveMetrics,
  applyOverrides,
} from './lib/metric-merge.mjs';

const METRIC_KEYS = [
  'numberOfHospitals',
  'bedCapacity',
  'operationalBeds',
  'bedsUnderDevelopment',
  'newHospitalsPlanned',
  'occupancyRate',
  'alos',
  'ipVolume',
  'opVolume',
  'arpob',
  'arpp',
  'revenue',
  'ebitda',
  'ebitdaMargin',
  'pat',
  'netDebt',
  'capexAnnounced',
  'revenueGrowthYoy',
  'roce',
];

const METRIC_UNIT = {
  numberOfHospitals: 'count',
  bedCapacity: 'count',
  operationalBeds: 'count',
  bedsUnderDevelopment: 'count',
  newHospitalsPlanned: 'count',
  occupancyRate: '%',
  alos: 'days',
  ipVolume: 'admissions',
  opVolume: 'visits',
  arpob: 'INR_per_day',
  arpp: 'INR_per_patient',
  revenue: 'INR_crore',
  ebitda: 'INR_crore',
  ebitdaMargin: '%',
  pat: 'INR_crore',
  netDebt: 'INR_crore',
  capexAnnounced: 'INR_crore',
  revenueGrowthYoy: '%',
  roce: '%',
};

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function fileDateFiscalQuarter(dateStr) {
  // Fallback: derive fiscal quarter from filing date when Gemini's
  // reportingPeriod is missing/unparseable.
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
  // Filings usually report on the PREVIOUS quarter (lag ~30-60 days),
  // so subtract 1 from quarter to get the reporting period.
  q -= 1;
  if (q === 0) {
    q = 4;
    fy = (fy === 0 ? 99 : fy - 1);
  }
  return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

function assignReportingQuarter(extraction) {
  // Prefer Gemini's reportingPeriod.fiscalQuarter; fallback to derived from date.
  return (
    normalizeQuarter(extraction.reportingPeriod?.fiscalQuarter) ||
    fileDateFiscalQuarter(extraction.date) ||
    extraction.fiscalQuarter ||
    null
  );
}

async function processCompany(company) {
  const slug = company.slug;
  const extractedFile = await loadJson(`data/extracted/${slug}.json`);
  const overrideFile = await loadJson(`data/overrides/${slug}.json`);
  const quoteFile = await loadJson(`data/quotes/${slug}.json`);
  const docsFile = await loadJson(`data/docs/${slug}.json`);
  const financialsFile = await loadJson(`data/financials/${slug}.json`);

  const extractions = extractedFile?.byNewsId
    ? Object.values(extractedFile.byNewsId).filter((e) => e.metrics && !e.error)
    : [];

  // Index BSE financials by fiscal quarter
  const financialsByFq = new Map();
  for (const row of financialsFile?.quarterly || []) {
    if (row.period) financialsByFq.set(row.period, row);
  }

  // Bucket extractions by reporting fiscal quarter
  const byQuarter = new Map();
  for (const ext of extractions) {
    const fq = assignReportingQuarter(ext);
    if (!fq) continue;
    if (!byQuarter.has(fq)) byQuarter.set(fq, []);
    byQuarter.get(fq).push(ext);
  }

  // ALSO include quarters that only have BSE financials (no LLM extraction)
  for (const fq of financialsByFq.keys()) {
    if (!byQuarter.has(fq)) byQuarter.set(fq, []);
  }

  // Latest quote (for valuation metrics)
  const latestSnap = quoteFile?.snapshots?.[quoteFile.snapshots.length - 1] || null;
  const marketCapCr = latestSnap?.marketCapFullCr ?? null;

  // Build a "metric object" from BSE structured financials (treat as a confirmed source).
  // SANITY-FILTERED — PDF-parse output is unreliable (unit detection issues, wrong column
  // picks) so we drop anything that doesn't pass plausibility checks and demote remaining
  // values to medium confidence (LLM extractions still win where available).
  function metricsFromFinancials(fin) {
    if (!fin) return {};
    const m = {};
    const set = (key, value, label) => {
      if (value == null) return;
      m[key] = {
        value,
        unit: METRIC_UNIT[key] || '',
        confidence: 'medium',
        quote: `BSE structured filing (${fin.type}) for ${fin.period}: ${label}`,
        source: { docType: 'bse-quarterly-result-api', newsId: null, date: fin.periodEnding, pdfUrl: fin.sourcePdfUrl || null },
      };
    };
    // Sanity: hospital sector quarterly revenue is 50-30,000 Cr
    if (fin.revenue != null && fin.revenue >= 50 && fin.revenue <= 30000) {
      set('revenue', fin.revenue, 'Revenue from operations');
    }
    // EBITDA margin sanity: -20% to 60%
    if (
      fin.ebitda != null &&
      fin.ebitdaMargin != null &&
      fin.ebitdaMargin >= -20 &&
      fin.ebitdaMargin <= 60 &&
      m.revenue
    ) {
      set('ebitda', fin.ebitda, 'EBITDA (derived: PBT + Depr + Finance cost)');
      set('ebitdaMargin', fin.ebitdaMargin, 'EBITDA margin');
    }
    // PAT margin sanity: -50% to 40%
    if (
      fin.pat != null &&
      fin.patMargin != null &&
      fin.patMargin >= -50 &&
      fin.patMargin <= 40 &&
      m.revenue
    ) {
      set('pat', fin.pat, 'Profit for the period');
    }
    return m;
  }

  // For every quarter, pick best value per metric, then derive
  const quarters = {};
  for (const fq of [...byQuarter.keys()].sort(compareQuarters)) {
    const exts = byQuarter.get(fq);
    const finRow = financialsByFq.get(fq);

    // Start from BSE structured financials (verified, high-confidence)
    const baseMetrics = metricsFromFinancials(finRow);

    // Overlay LLM extractions — but only fill in metrics not already provided
    // (BSE structured > LLM extraction for items both can supply)
    for (const key of METRIC_KEYS) {
      if (baseMetrics[key]) continue; // BSE already provided
      const picked = pickBestForMetric(exts, key);
      if (picked) baseMetrics[key] = picked;
    }

    // Apply manual overrides (always wins)
    const merged = applyOverrides(baseMetrics, overrideFile?.[fq]);
    const derived = deriveMetrics({ metrics: merged, marketCapCr });

    const range = quarterRange(fq);
    const sourceList = exts.map((e) => ({
      docType: e.docType,
      newsId: e.newsId,
      date: e.date,
      pdfUrl: e.pdfUrl,
    }));
    if (finRow) {
      sourceList.unshift({
        docType: 'bse-financials-api',
        newsId: null,
        date: finRow.periodEnding,
        pdfUrl: null,
        note: `${finRow.type} quarterly result`,
      });
    }

    quarters[fq] = {
      fiscalQuarter: fq,
      label: range?.label || fq,
      calendar: range?.calendar || null,
      from: range?.from || null,
      to: range?.to || null,
      sourceExtractions: sourceList,
      metrics: merged,
      derived,
    };
  }

  // Sort quarters newest-first for dashboard convenience
  const sortedFqs = [...byQuarter.keys()].sort((a, b) => compareQuarters(b, a));
  const orderedQuarters = Object.fromEntries(sortedFqs.map((fq) => [fq, quarters[fq]]));

  const out = {
    slug,
    scripCode: company.scripCode,
    name: company.name,
    shortName: company.shortName,
    sector: latestSnap?.sector || 'Healthcare',
    industry: latestSnap?.industry || 'Hospital',
    ticker: latestSnap?.ticker || null,
    isin: latestSnap?.isin || null,
    lastBuiltAt: new Date().toISOString(),
    latestQuote: latestSnap
      ? {
          date: latestSnap.date,
          price: latestSnap.price,
          marketCapCr: latestSnap.marketCapFullCr,
          marketCapFreeFloatCr: latestSnap.marketCapFreeFloatCr,
          changePct: latestSnap.changePct,
          volumeShares: latestSnap.volumeShares,
        }
      : null,
    coverage: {
      extractedDocs: extractions.length,
      quartersWithData: sortedFqs.length,
      quarterRange:
        sortedFqs.length > 0
          ? `${sortedFqs[sortedFqs.length - 1]} → ${sortedFqs[0]}`
          : null,
      classifiedTotalPriorityDocs: docsFile?.summary?.byDocType
        ? ['investor-presentation', 'concall-transcript', 'quarterly-result', 'press-release']
            .reduce((s, k) => s + (docsFile.summary.byDocType[k] || 0), 0)
        : null,
    },
    quarters: orderedQuarters,
  };

  const path = `data/metrics/${slug}.json`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2));
  return out;
}

async function run() {
  const companies = await loadCompanies();
  console.error(`Building per-company metrics for ${companies.length} cos…\n`);
  const summary = [];
  for (const c of companies) {
    try {
      const out = await processCompany(c);
      summary.push({
        slug: c.slug,
        quarters: Object.keys(out.quarters).length,
        extractedDocs: out.coverage.extractedDocs,
        range: out.coverage.quarterRange,
      });
      console.error(
        `  ${c.slug.padEnd(22)} ${String(out.coverage.extractedDocs).padStart(3)} docs · ` +
          `${String(Object.keys(out.quarters).length).padStart(2)} quarters · ${out.coverage.quarterRange || '—'}`
      );
    } catch (e) {
      console.error(`  ${c.slug.padEnd(22)} FAILED: ${e.message}`);
    }
  }
  console.error(`\nWrote data/metrics/*.json for ${summary.length} companies.`);
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
