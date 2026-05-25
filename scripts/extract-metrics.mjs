#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCompanies } from './lib/bse.mjs';
import { downloadPdf } from './lib/pdf.mjs';
import { callGeminiWithPdf, DEFAULT_MODEL, KeyPool } from './lib/gemini.mjs';

const RAW_KEYS = process.env.GEMINI_API_KEY || '';
const KEY_POOL = new KeyPool(RAW_KEYS);
const MAX_PER_RUN = Number(process.env.MAX_EXTRACTIONS_PER_RUN || 40);
const PER_CALL_DELAY_MS = Number(process.env.GEMINI_CALL_DELAY_MS || 4500); // ~13 RPM, under 15 RPM limit
const PRIORITY_TYPES = ['investor-presentation', 'quarterly-result', 'concall-transcript', 'press-release'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Master metric list — used for prompt + normalization ────────────────
const METRIC_SPEC = [
  // Network & infrastructure
  ['numberOfHospitals',   'count',        'Total number of hospitals operated'],
  ['bedCapacity',         'count',        'Total bed capacity (potential, including unactivated beds)'],
  ['operationalBeds',     'count',        'Beds actually in operation / activated'],
  ['bedsUnderDevelopment','count',        'Beds under construction / planned activation'],
  ['newHospitalsPlanned', 'count',        'New hospitals announced/under construction (pipeline)'],

  // Operations
  ['occupancyRate',       '%',            'Hospital bed occupancy percentage (e.g., 65.5 means 65.5%)'],
  ['alos',                'days',         'Average Length of Stay in days'],
  ['ipVolume',            'admissions',   'Inpatient admissions for the period'],
  ['opVolume',            'visits',       'Outpatient visits for the period'],

  // Revenue quality
  ['arpob',               'INR_per_day',  'Average Revenue Per Occupied Bed per day, in rupees'],
  ['arpp',                'INR_per_patient', 'Average Revenue Per Patient, in rupees'],

  // Financials (always in INR Crore for value, regardless of how PDF displays)
  ['revenue',             'INR_crore',    'Total operating revenue for the period, in INR Crore'],
  ['ebitda',              'INR_crore',    'EBITDA for the period, in INR Crore'],
  ['ebitdaMargin',        '%',            'EBITDA margin percentage'],
  ['pat',                 'INR_crore',    'Profit After Tax for the period, in INR Crore'],
  ['netDebt',             'INR_crore',    'Net debt at period end, in INR Crore (negative if net cash)'],
  ['capexAnnounced',      'INR_crore',    'Capex spent or planned for the period, in INR Crore'],

  // Growth / capital efficiency
  ['revenueGrowthYoy',    '%',            'Revenue growth year-on-year, percentage'],
  ['roce',                '%',            'Return on Capital Employed, percentage'],
];

const METRIC_KEYS = METRIC_SPEC.map(([k]) => k);

function buildPrompt(company, doc) {
  const metricLines = METRIC_SPEC.map(
    ([k, unit, desc]) => `  - ${k} (unit: ${unit}) — ${desc}`
  ).join('\n');

  return `You are an equity research analyst specializing in the Indian hospital sector.

Company: ${company.name} (BSE: ${company.scripCode})
Document type: ${doc.docType}
Document date: ${doc.date}
Fiscal quarter (per filing date): ${doc.fiscalQuarter || 'unknown'}

Task: Extract the following operational and financial metrics from the attached PDF.

METRICS (each with units specified):
${metricLines}

For EACH metric, return an object:
  { "value": number | null, "unit": "<the specified unit>", "confidence": "high" | "medium" | "low", "quote": "<exact text snippet from the PDF supporting this value, or empty string>" }

RULES — read carefully:
1. NEVER make up numbers. If a metric is not stated in this document, set value=null and quote="".
2. Convert all currency to the unit specified. Examples:
   - "Revenue ₹2,150 Cr" → revenue.value = 2150 (already in INR_crore)
   - "Revenue ₹21.50 billion" → revenue.value = 2150
   - "ARPOB ₹66,500" → arpob.value = 66500 (per day, in rupees)
   - If the doc gives ARPOB monthly, convert to per-day (÷ 30)
3. Percentages as numbers (e.g., 65.5 = 65.5%, not 0.655).
4. **PERIOD — CRITICAL.** For P&L flow items (revenue, ebitda, pat, ipVolume, opVolume, capexAnnounced), extract values for the SINGLE QUARTER only. Never use YTD, H1, 9M, or full-year totals for these items:
   - Q1 deck → only Q1 numbers (NOT YTD)
   - Q2 deck → only Q2 numbers (NOT H1)
   - Q3 deck → only Q3 numbers (NOT 9M YTD)
   - Q4 / annual deck → only Q4 quarterly numbers (NOT full-year FY)
   - Decks typically show side-by-side columns like "Q3 FY26" and "9M FY26". Always use the single-quarter column.
   - If a flow item is ONLY reported as YTD/H1/9M/FY (no single-quarter breakout), set value=null with quote="".
   For STOCK / point-in-time metrics (occupancy, ARPOB, ARPP, ALOS, bed counts, hospital counts, netDebt), use the latest period-end snapshot from the document — those are typically reported as the single value, not cumulative.
5. For mix-percentages (revenue mix, payor mix), this version only asks for top-level totals — don't include mix details.
6. Pick the MOST RECENT period reported (this quarter, not last year's prior comparison).
7. Confidence guide:
   - high: explicitly stated as a metric label and value (e.g., "Occupancy: 65.2%")
   - medium: clearly derivable from text (e.g., "occupancy improved to 65%")
   - low: inferred or buried in narrative
8. The "quote" must be a direct copy of text from the document (max ~200 chars). Use this so an analyst can verify.

ALSO return:
- reportingPeriod: { "fiscalQuarter": "<like Q3 FY26 if discernible from doc, else null>", "periodEnding": "<YYYY-MM-DD if mentioned>" }
- notes: brief free-text caveats (currency conversions assumed, ambiguous figures, etc.)

OUTPUT — return ONLY a single JSON object with this exact structure:
{
  "reportingPeriod": { "fiscalQuarter": ..., "periodEnding": ... },
  "metrics": {
    "numberOfHospitals": { ... },
    ... (all metrics from the list above, even if value is null)
  },
  "notes": "..."
}

No markdown, no prose outside the JSON. Just the object.`;
}

function normalizeExtraction(parsed) {
  const metrics = {};
  const raw = parsed?.metrics || {};
  for (const key of METRIC_KEYS) {
    const m = raw[key];
    if (m && typeof m === 'object') {
      metrics[key] = {
        value: typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null,
        unit: String(m.unit || ''),
        confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'low',
        quote: typeof m.quote === 'string' ? m.quote.slice(0, 400) : '',
      };
    } else {
      metrics[key] = { value: null, unit: '', confidence: 'low', quote: '' };
    }
  }
  return {
    reportingPeriod: {
      fiscalQuarter: parsed?.reportingPeriod?.fiscalQuarter || null,
      periodEnding: parsed?.reportingPeriod?.periodEnding || null,
    },
    metrics,
    notes: String(parsed?.notes || '').slice(0, 1000),
  };
}

function collectPriorityDocs(docsFile) {
  const out = [];
  for (const fq of Object.keys(docsFile.byQuarter || {})) {
    const q = docsFile.byQuarter[fq];
    for (const type of PRIORITY_TYPES) {
      const docs = q.priorityDocs?.[type] || [];
      for (const d of docs) {
        if (d.pdfUrl) out.push({ ...d, fiscalQuarter: fq });
      }
    }
  }
  // newest first → backfill recent quarters first (most useful)
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}

async function loadExisting(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function processCompany(company, budget) {
  const docsPath = `data/docs/${company.slug}.json`;
  const outPath = `data/extracted/${company.slug}.json`;

  const docs = JSON.parse(await readFile(docsPath, 'utf8'));
  const existing = (await loadExisting(outPath)) || {
    slug: company.slug,
    scripCode: company.scripCode,
    name: company.name,
    byNewsId: {},
  };
  if (!existing.byNewsId) existing.byNewsId = {};

  const MAX_RETRY_ATTEMPTS = 3;
  const priorityDocs = collectPriorityDocs(docs);
  const pending = priorityDocs.filter((d) => {
    const cached = existing.byNewsId[String(d.newsId)];
    if (!cached) return true;
    if (cached.metrics) return false; // successful extraction → never re-call
    return (cached.attemptCount || 1) < MAX_RETRY_ATTEMPTS; // transient failure → retry up to 3 total attempts
  });
  const retryCount = pending.filter((d) => existing.byNewsId[String(d.newsId)]?.error).length;
  console.error(`  ${company.slug.padEnd(22)} ${priorityDocs.length} priority docs · ${pending.length} pending (${retryCount} retries of past failures) · ${Object.keys(existing.byNewsId).length} cached`);

  let extracted = 0;
  let errors = 0;
  for (const doc of pending) {
    if (budget.remaining <= 0) {
      console.error(`    budget exhausted (${MAX_PER_RUN}), stopping early`);
      break;
    }
    budget.remaining--;

    const tag = `[${doc.fiscalQuarter}/${doc.docType}/${doc.date}]`;
    process.stderr.write(`    ${tag} ${String(doc.subject || '').slice(0, 60)} … `);

    try {
      const { buf: pdfBuf, sourcePath } = await downloadPdf(doc.pdfUrl);
      const { parsed, finishReason, usage, model, keyIndex } = await callGeminiWithPdf({
        pdfBuffer: pdfBuf,
        prompt: buildPrompt(company, doc),
        keyPool: KEY_POOL,
      });
      const norm = normalizeExtraction(parsed);
      const nonNull = Object.values(norm.metrics).filter((m) => m.value != null).length;
      existing.byNewsId[String(doc.newsId)] = {
        newsId: doc.newsId,
        docType: doc.docType,
        fiscalQuarter: doc.fiscalQuarter,
        date: doc.date,
        subject: doc.subject,
        pdfUrl: doc.pdfUrl,
        sourcePath,
        model,
        extractedAt: new Date().toISOString(),
        finishReason: finishReason || null,
        promptTokens: usage?.promptTokenCount ?? null,
        responseTokens: usage?.candidatesTokenCount ?? null,
        reportingPeriod: norm.reportingPeriod,
        metrics: norm.metrics,
        notes: norm.notes,
        nonNullMetricCount: nonNull,
      };
      extracted++;
      console.error(`OK [${sourcePath}] (${nonNull}/${METRIC_KEYS.length} metrics)`);
    } catch (e) {
      const prior = existing.byNewsId[String(doc.newsId)] || {};
      const attemptCount = (prior.attemptCount || 0) + 1;
      existing.byNewsId[String(doc.newsId)] = {
        newsId: doc.newsId,
        docType: doc.docType,
        fiscalQuarter: doc.fiscalQuarter,
        date: doc.date,
        subject: doc.subject,
        pdfUrl: doc.pdfUrl,
        extractedAt: new Date().toISOString(),
        error: e.message,
        attemptCount,
        metrics: null,
      };
      errors++;
      console.error(`FAIL (attempt ${attemptCount}) ${e.message}`);

      // Persist this failure BEFORE bailing on daily quota
      await mkdir(dirname(outPath), { recursive: true });
      existing.lastExtractionAt = new Date().toISOString();
      existing.model = DEFAULT_MODEL;
      await writeFile(outPath, JSON.stringify(existing, null, 2));

      if (e.dailyQuotaExceeded) {
        console.error('    ⛔ Gemini daily quota exhausted — aborting run, resume tomorrow');
        budget.quotaExhausted = true;
        return { slug: company.slug, extracted, errors, totalCached: Object.keys(existing.byNewsId).length, pendingRemaining: pending.length - extracted - errors, quotaExhausted: true };
      }
    }

    // Persist after every extraction — resumable, never lose progress
    await mkdir(dirname(outPath), { recursive: true });
    existing.lastExtractionAt = new Date().toISOString();
    existing.model = DEFAULT_MODEL;
    await writeFile(outPath, JSON.stringify(existing, null, 2));

    if (budget.remaining > 0 && pending.indexOf(doc) < pending.length - 1) {
      await sleep(PER_CALL_DELAY_MS);
    }
  }

  return { slug: company.slug, extracted, errors, totalCached: Object.keys(existing.byNewsId).length, pendingRemaining: Math.max(0, pending.length - extracted - errors) };
}

async function run() {
  if (KEY_POOL.size() === 0) {
    console.error('ERROR: GEMINI_API_KEY env var not set. Add it to the workflow with `env: GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` or export locally.');
    console.error('       Multiple keys supported — comma-separate them in the same secret.');
    process.exit(0);
  }
  console.error(`Gemini extraction — model=${DEFAULT_MODEL}, budget=${MAX_PER_RUN} extractions, delay=${PER_CALL_DELAY_MS}ms`);
  console.error(`  keys available: ${KEY_POOL.size()} (rotating round-robin; dead keys skipped)\n`);

  const companies = await loadCompanies();
  const budget = { remaining: MAX_PER_RUN };
  const summary = [];

  for (const c of companies) {
    if (budget.quotaExhausted) {
      console.error(`\n— Gemini daily quota exhausted; skipping ${c.slug} —`);
      summary.push({ slug: c.slug, skipped: true, reason: 'daily quota' });
      continue;
    }
    if (budget.remaining <= 0) {
      console.error(`\n— budget exhausted before ${c.slug}; will resume next run —`);
      summary.push({ slug: c.slug, skipped: true });
      continue;
    }
    const s = await processCompany(c, budget);
    summary.push(s);
    if (s.quotaExhausted) {
      console.error('\n— stopping all further company processing this run —');
      break;
    }
  }

  console.error('\n=== Extraction summary ===');
  let totalExtracted = 0,
    totalErrors = 0,
    totalCached = 0,
    totalPending = 0;
  for (const s of summary) {
    if (s.skipped) {
      console.error(`  ${s.slug.padEnd(22)} skipped (budget exhausted)`);
      continue;
    }
    console.error(`  ${s.slug.padEnd(22)} +${s.extracted} new · ${s.errors} errors · ${s.totalCached} total · ${s.pendingRemaining} pending`);
    totalExtracted += s.extracted;
    totalErrors += s.errors;
    totalCached += s.totalCached;
    totalPending += s.pendingRemaining;
  }
  console.error(`\n  TOTAL: +${totalExtracted} new this run · ${totalErrors} errors · ${totalCached} cached overall · ${totalPending} still pending`);
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
