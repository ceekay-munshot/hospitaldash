#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCompanies } from './lib/bse.mjs';
import {
  normalizeQuarter,
  quarterRange,
  compareQuarters,
  deriveMetrics,
} from './lib/metric-merge.mjs';
import { resolveMetric, flagTrendSpikes, CLIENT_SAFE } from './lib/validation.mjs';

// Module-level review queue, accumulated across all companies.
const REVIEW_QUEUE = [];

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

  // Collect ALL candidate values per (metric, quarter) from every source.
  // BSE structured financials count as one extra source with their own docType.
  function candidatesFor(fq, key) {
    const exts = byQuarter.get(fq) || [];
    const cands = [];
    for (const e of exts) {
      const m = e.metrics?.[key];
      if (m && m.value != null) {
        cands.push({
          value: m.value,
          confidence: m.confidence,
          quote: m.quote,
          docType: e.docType,
          date: e.date,
          pdfUrl: e.pdfUrl,
        });
      }
    }
    // NOTE: BSE structured-financials (PDF-parse) deliberately NOT used as a
    // candidate — its unit detection is unreliable (e.g. Medanta rev parsed as
    // 960629, Fortis 236467). LLM extractions + manual overrides are the trusted
    // sources. Kept on disk for reference but excluded from the merge.
    return cands;
  }

  // For every quarter, resolve each metric through the validation layer.
  const quarters = {};
  for (const fq of [...byQuarter.keys()].sort(compareQuarters)) {
    const range = quarterRange(fq);
    const metrics = {};

    for (const key of METRIC_KEYS) {
      const cands = candidatesFor(fq, key);
      const override = overrideFile?.[fq]?.[key];
      if (cands.length === 0 && !override) continue;

      const resolved = resolveMetric(key, cands, { override });
      metrics[key] = {
        value: resolved.value,
        unit: METRIC_UNIT[key] || '',
        confidence: resolved.confidence,
        status: resolved.status,
        clientSafe: CLIENT_SAFE.has(resolved.status),
        sources: resolved.sources,
        reason: resolved.reason,
      };

      // Anything not client-safe (and not already overridden) → review queue
      if (!CLIENT_SAFE.has(resolved.status)) {
        REVIEW_QUEUE.push({
          company: slug,
          fiscalQuarter: fq,
          metric: key,
          status: resolved.status,
          reason: resolved.reason,
          pickedValue: resolved.value,
          candidates: (resolved.sources || []).map((s) => ({
            value: s.value, docType: s.docType, date: s.date, pdfUrl: s.pdfUrl,
          })),
          rejected: resolved.rejected || [],
        });
      }
    }

    quarters[fq] = {
      fiscalQuarter: fq,
      label: range?.label || fq,
      calendar: range?.calendar || null,
      from: range?.from || null,
      to: range?.to || null,
      metrics,
      derived: {},
    };
  }

  const oldestFirst = [...byQuarter.keys()].sort(compareQuarters);

  // Helper: only use a metric value in derivations if it's client-safe.
  const safeVal = (fq, key) => {
    const m = quarters[fq]?.metrics?.[key];
    return m && m.clientSafe ? m.value : null;
  };

  // ── Outlier gate (runs BEFORE derivations so derived metrics never build on
  // a contaminated value). A value wildly off this company's OWN median for a
  // metric is almost certainly period-contamination (annual/YTD in a quarter
  // slot). Catches endpoint outliers the neighbour-based check misses — incl.
  // the LATEST quarter, which is the most demo-critical. Flag + withhold.
  const OUTLIER_METRICS = {
    revenue: [0.4, 2.5], ebitda: [0.35, 2.8], pat: [0.25, 3.5],
    arpob: [0.6, 1.8], operationalBeds: [0.5, 2.0], bedCapacity: [0.5, 2.0],
    ipVolume: [0.4, 2.6], opVolume: [0.4, 2.6],
  };
  const medianOf = (nums) => {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  for (const [key, [loM, hiM]] of Object.entries(OUTLIER_METRICS)) {
    for (let i = 0; i < oldestFirst.length; i++) {
      const fq = oldestFirst[i];
      const m = quarters[fq]?.metrics?.[key];
      if (!m || !m.clientSafe) continue;
      // Never override stronger evidence than the heuristic: a manual override
      // or a multi-source-agreeing (corroborated) value beats the median check.
      if (m.status === 'verified' || m.status === 'corroborated') continue;
      const v = m.value;
      if (v == null) continue;

      // Reference = median of up to 4 PRIOR client-safe values (look-back only).
      // Robust to far-history contamination; still catches latest-quarter outliers.
      const priors = [];
      for (let j = i - 1; j >= 0 && priors.length < 4; j--) {
        const pv = safeVal(oldestFirst[j], key);
        if (pv != null) priors.push(pv);
      }
      if (priors.length < 3) continue; // not enough recent history to judge
      const med = medianOf(priors);
      if (!med) continue;

      if (v < med * loM || v > med * hiM) {
        m.clientSafe = false;
        m.status = 'review';
        m.reason = `outlier vs recent median ${Math.round(med)} (×${(v / med).toFixed(1)})`;
        REVIEW_QUEUE.push({
          company: slug, fiscalQuarter: fq, metric: key, status: 'outlier',
          reason: m.reason, pickedValue: v,
          candidates: (m.sources || []).map((s) => ({ value: s.value, docType: s.docType, date: s.date, pdfUrl: s.pdfUrl })),
        });
      }
    }
  }

  // ── Per-quarter derived metrics (point-in-time; native period, NOT annualised) ──
  for (const fq of oldestFirst) {
    const q = quarters[fq];
    const revenue = safeVal(fq, 'revenue');
    const ebitda = safeVal(fq, 'ebitda');
    const pat = safeVal(fq, 'pat');
    const opBeds = safeVal(fq, 'operationalBeds');
    const totalBeds = safeVal(fq, 'bedCapacity');
    const ipVol = safeVal(fq, 'ipVolume');
    const occ = safeVal(fq, 'occupancyRate');

    // PAT margin (quarter-native)
    if (pat != null && revenue) q.derived.patMargin = Number(((pat / revenue) * 100).toFixed(2));

    // Vacant beds (Simran's request) — point-in-time
    if (totalBeds != null && opBeds != null && totalBeds >= opBeds) {
      q.derived.vacantBeds = totalBeds - opBeds;
    }
    // Bed utilization (renamed from "Bed Activation") = operational / capacity
    if (totalBeds && opBeds) {
      q.derived.bedUtilizationPct = Number(((opBeds / totalBeds) * 100).toFixed(1));
    }
    // Operating beds per hospital
    const hospitals = safeVal(fq, 'numberOfHospitals');
    if (opBeds != null && hospitals) {
      q.derived.bedsPerHospital = Math.round(opBeds / hospitals);
    }
    // Revenue / EBITDA per bed — QUARTER-NATIVE (not annualised; Simran's explicit ask)
    if (revenue != null && opBeds) {
      q.derived.revenuePerBedQuarter = Math.round((revenue * 1e7) / opBeds);
    }
    if (ebitda != null && opBeds) {
      q.derived.ebitdaPerBedQuarter = Math.round((ebitda * 1e7) / opBeds);
    }
    // Bed turnover — QUARTER-NATIVE (admissions in the quarter per operational bed)
    if (ipVol != null && opBeds) {
      q.derived.bedTurnoverQuarter = Number((ipVol / opBeds).toFixed(2));
    }
  }

  // ── TTM + cross-quarter derived metrics ──
  for (let i = 0; i < oldestFirst.length; i++) {
    const fq = oldestFirst[i];
    const q = quarters[fq];

    if (i >= 3) {
      const win = oldestFirst.slice(i - 3, i + 1);
      const revs = win.map((f) => safeVal(f, 'revenue')).filter((v) => v != null);
      const ebs = win.map((f) => safeVal(f, 'ebitda')).filter((v) => v != null);
      const pats = win.map((f) => safeVal(f, 'pat')).filter((v) => v != null);

      if (revs.length === 4) q.derived.revenueTtmCr = Number(revs.reduce((s, v) => s + v, 0).toFixed(1));
      if (ebs.length === 4) {
        const ttm = ebs.reduce((s, v) => s + v, 0);
        q.derived.ebitdaTtmCr = Number(ttm.toFixed(1));
        const netDebt = safeVal(fq, 'netDebt');
        if (netDebt != null && ttm > 0) q.derived.netDebtToEbitda = Number((netDebt / ttm).toFixed(2));
      }
      if (pats.length === 4) q.derived.patTtmCr = Number(pats.reduce((s, v) => s + v, 0).toFixed(1));
    }

    // Revenue CAGR 3-yr from TTM (more robust than single-quarter ratio)
    if (i >= 15) {
      const oldTtm = quarters[oldestFirst[i - 12]]?.derived?.revenueTtmCr;
      const newTtm = q.derived.revenueTtmCr;
      if (oldTtm != null && newTtm != null && oldTtm > 0) {
        const ratio = newTtm / oldTtm;
        if (ratio >= 0.6 && ratio <= 4) {
          q.derived.revenueCagr3yr = Number(((Math.pow(ratio, 1 / 3) - 1) * 100).toFixed(2));
        }
      }
    }
  }

  // ── Valuation (uses latest market cap; only for latest quarter) ──
  {
    const latestFqLocal = oldestFirst[oldestFirst.length - 1];
    const q = quarters[latestFqLocal];
    if (q && marketCapCr != null) {
      const netDebt = safeVal(latestFqLocal, 'netDebt');
      const ev = marketCapCr + (netDebt ?? 0);
      q.derived.enterpriseValueCr = Number(ev.toFixed(1));
      const ebitdaTtm = q.derived.ebitdaTtmCr;
      const patTtm = q.derived.patTtmCr;
      const opBeds = safeVal(latestFqLocal, 'operationalBeds');
      if (ebitdaTtm != null && ebitdaTtm > 0) q.derived.evToEbitda = Number((ev / ebitdaTtm).toFixed(2));
      if (patTtm != null && patTtm > 0) q.derived.peTtm = Number((marketCapCr / patTtm).toFixed(2));
      if (opBeds) q.derived.evPerBedLakhs = Number(((ev * 100) / opBeds).toFixed(1));
    }
  }


  // Sort quarters newest-first for dashboard convenience
  const sortedFqs = [...byQuarter.keys()].sort((a, b) => compareQuarters(b, a));
  const orderedQuarters = Object.fromEntries(sortedFqs.map((fq) => [fq, quarters[fq]]));

  // ── Period aggregations: FY rollups + period-aware views ────────────
  // Stock metrics = point-in-time (use period-end value, not summed).
  // Flow metrics = period totals (sum quarters within period).
  // Ratio metrics = recompute from period's flow values.
  const FLOW = ['revenue', 'ebitda', 'pat', 'ipVolume', 'opVolume', 'capexAnnounced'];
  const STOCK = ['numberOfHospitals', 'bedCapacity', 'operationalBeds', 'bedsUnderDevelopment',
                 'newHospitalsPlanned', 'occupancyRate', 'arpob', 'arpp', 'alos', 'netDebt'];

  // Parse fiscal year from quarter key like FY26-Q3 → 26
  const fyOf = (fq) => {
    const m = /^FY(\d{2})-Q[1-4]$/.exec(fq);
    return m ? Number(m[1]) : null;
  };
  const qNumOf = (fq) => {
    const m = /^FY(\d{2})-Q([1-4])$/.exec(fq);
    return m ? Number(m[2]) : null;
  };

  // Group quarters by FY
  const fyBuckets = new Map();
  for (const fq of oldestFirst) {
    const fy = fyOf(fq);
    if (fy == null) continue;
    if (!fyBuckets.has(fy)) fyBuckets.set(fy, []);
    fyBuckets.get(fy).push(fq);
  }

  // Build a "period view" for a set of quarters within a period
  // periodEndFq = the LAST quarter in the period (for stock metrics)
  function buildPeriodView(quartersInPeriod, periodEndFq) {
    const view = { metrics: {}, derived: {} };
    if (!quartersInPeriod.length) return view;

    // Flow metrics: sum across quarters
    for (const key of FLOW) {
      const vals = quartersInPeriod.map((fq) => safeVal(fq, key)).filter((v) => v != null);
      if (vals.length) {
        view.metrics[key] = {
          value: Number(vals.reduce((s, v) => s + v, 0).toFixed(2)),
          unit: METRIC_UNIT[key] || '',
          confidence: vals.length === quartersInPeriod.length ? 'high' : 'medium',
          clientSafe: true,
          source: { docType: 'period-aggregate', quarters: quartersInPeriod.length },
        };
      }
    }

    // Stock metrics: take the period-end value
    for (const key of STOCK) {
      const v = safeVal(periodEndFq, key);
      if (v != null) {
        view.metrics[key] = {
          value: v,
          unit: METRIC_UNIT[key] || '',
          confidence: 'high',
          clientSafe: true,
          source: { docType: 'period-end', endingQuarter: periodEndFq },
        };
      }
    }

    // Ratio metrics: recompute from flow values in the period
    const revenue = view.metrics.revenue?.value;
    const ebitda = view.metrics.ebitda?.value;
    const pat = view.metrics.pat?.value;
    if (ebitda != null && revenue) {
      view.metrics.ebitdaMargin = {
        value: Number(((ebitda / revenue) * 100).toFixed(2)),
        unit: '%', confidence: 'high', clientSafe: true,
        source: { docType: 'period-derived' },
      };
    }
    if (pat != null && revenue) {
      view.derived.patMargin = Number(((pat / revenue) * 100).toFixed(2));
    }

    // Per-bed metrics scoped to period (no annualization needed — it IS the period)
    const opBeds = view.metrics.operationalBeds?.value;
    if (revenue != null && opBeds) {
      view.derived.revenuePerBed = Math.round((revenue * 1e7) / opBeds);
    }
    if (ebitda != null && opBeds) {
      view.derived.ebitdaPerBed = Math.round((ebitda * 1e7) / opBeds);
    }
    // Bed turnover scoped to period (admissions in this period per operational bed)
    const ipVol = view.metrics.ipVolume?.value;
    if (ipVol != null && opBeds) {
      view.derived.bedTurnover = Number((ipVol / opBeds).toFixed(2));
    }

    return view;
  }

  // Build FY views — only for FYs where we have all 4 quarters (or current partial FY).
  const fyViews = {};
  for (const [fy, qs] of fyBuckets.entries()) {
    const sortedQs = [...qs].sort(compareQuarters);
    const periodEnd = sortedQs[sortedQs.length - 1];
    const fyKey = `FY${String(fy).padStart(2, '0')}`;
    const view = buildPeriodView(sortedQs, periodEnd);
    view.label = sortedQs.length === 4 ? fyKey : `${fyKey} (${sortedQs.length}Q)`;
    view.complete = sortedQs.length === 4;
    view.quartersUsed = sortedQs;
    fyViews[fyKey] = view;
  }

  // Build TTM views — trailing 4 quarters ending at each quarter
  const ttmViews = {};
  for (let i = 0; i < oldestFirst.length; i++) {
    if (i < 3) continue; // need 4 quarters
    const win = oldestFirst.slice(i - 3, i + 1);
    const view = buildPeriodView(win, oldestFirst[i]);
    view.label = `TTM @ ${oldestFirst[i]}`;
    view.quartersUsed = win;
    ttmViews[oldestFirst[i]] = view;
  }

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
    // NEW: period-aware views. Frontend toggles between these.
    periodViews: {
      fy: fyViews,        // { 'FY26': { metrics, derived, label, complete }, 'FY25': {...} }
      ttm: ttmViews,      // { 'FY27-Q1': { metrics, derived, label }, ... }
    },
    latestQuarter: sortedFqs[0] || null,
    latestCompleteFy: Object.keys(fyViews).filter((k) => fyViews[k].complete).sort().pop() || null,
    latestTtm: oldestFirst[oldestFirst.length - 1] || null,
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

  // ── Prioritise + write the review queue ─────────────────────────────
  // Core metrics Simran explicitly tracks — flags here are demo-critical.
  const CORE_METRICS = new Set([
    'revenue', 'ebitda', 'ebitdaMargin', 'pat', 'arpob', 'occupancyRate',
    'alos', 'operationalBeds', 'bedCapacity', 'numberOfHospitals',
  ]);
  // The latest 2 fiscal quarters across the whole dataset.
  const allQ = [...new Set(REVIEW_QUEUE.map((r) => r.fiscalQuarter))].sort(compareQuarters);
  const recentQ = new Set(allQ.slice(-2));

  for (const r of REVIEW_QUEUE) {
    const core = CORE_METRICS.has(r.metric);
    const recent = recentQ.has(r.fiscalQuarter);
    r.priority = core && recent ? 'P0' : recent ? 'P1' : core ? 'P2' : 'P3';
  }

  const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
  REVIEW_QUEUE.sort((a, b) => {
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    const q = compareQuarters(b.fiscalQuarter, a.fiscalQuarter);
    if (q !== 0) return q;
    return a.company.localeCompare(b.company);
  });

  const byStatus = {};
  const byPriority = {};
  for (const r of REVIEW_QUEUE) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
  }

  const queue = {
    generatedAt: new Date().toISOString(),
    total: REVIEW_QUEUE.length,
    byPriority,
    byStatus,
    legend: {
      P0: 'Core metric (revenue/ebitda/margin/pat/arpob/occupancy/alos/beds/hospitals) in latest 2 quarters — FIX BEFORE CLIENT',
      P1: 'Non-core metric in latest 2 quarters',
      P2: 'Core metric in older quarter',
      P3: 'Non-core metric in older quarter',
    },
    note: 'Fill the correct value into data/overrides/<company>.json to clear an item. Source PDFs are in each item\'s candidates[].pdfUrl.',
    items: REVIEW_QUEUE,
  };
  await writeFile('data/review-queue.json', JSON.stringify(queue, null, 2));

  console.error(`\n=== Review queue: ${REVIEW_QUEUE.length} items ===`);
  console.error(`  by priority: ${['P0', 'P1', 'P2', 'P3'].map((p) => `${p}=${byPriority[p] || 0}`).join('  ')}`);

  const p0 = REVIEW_QUEUE.filter((r) => r.priority === 'P0');
  console.error(`\n  🔴 P0 — demo-critical (${p0.length}):`);
  for (const r of p0) {
    console.error(`    ${r.company.padEnd(20)} ${r.fiscalQuarter} ${r.metric.padEnd(18)} ${r.reason}`);
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
