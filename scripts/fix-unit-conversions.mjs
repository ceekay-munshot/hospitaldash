#!/usr/bin/env node
// Post-process existing extractions: detect unit-conversion mistakes via the
// quote text and correct values in place. Zero API cost. Run after extraction
// to clean up "INR 11,958 Mn" → 1,195.8 Cr style errors.

import { readFile, writeFile } from 'node:fs/promises';
import { loadCompanies } from './lib/bse.mjs';

// Each fix has a test() that returns true for matching extractions, and a
// factor (number or function) that transforms the value.
const UNIT_FIXES = [
  // Million → Crore (÷ 10) — for INR Cr metrics
  {
    name: 'million → crore',
    appliesTo: ['revenue', 'ebitda', 'pat', 'netDebt', 'capexAnnounced'],
    quoteRe: /(\b(?:million|\bMn\b|\bmn\b|\bMillion\b|\bMillions\b))/,
    factor: 0.1,
  },
  // Lakh → Crore (÷ 100)
  {
    name: 'lakh → crore',
    appliesTo: ['revenue', 'ebitda', 'pat', 'netDebt', 'capexAnnounced'],
    quoteRe: /(\b(?:lakh|lakhs|lac|lacs|Lakh|Lakhs|Lac|Lacs)\b)/,
    factor: 0.01,
  },
  // Billion → Crore (× 100)
  {
    name: 'billion → crore',
    appliesTo: ['revenue', 'ebitda', 'pat', 'netDebt', 'capexAnnounced'],
    quoteRe: /(\b(?:billion|billions|Bn|bn|Bn\.)\b)/,
    factor: 100,
  },
  // ARPOB: Cr per annum → INR per day (× 1e7 ÷ 365)
  {
    name: 'Cr/year → INR/day',
    appliesTo: ['arpob', 'arpp'],
    quoteRe: /(Cr|crore|Crore).{0,40}(per\s*annum|annual|per\s*year|yearly)/i,
    factor: (v) => (v * 1e7) / 365,
  },
  // ARPOB: lakh per day → INR per day (× 1e5)
  {
    name: 'lakh/day → INR/day',
    appliesTo: ['arpob', 'arpp'],
    quoteRe: /(lakh|lac).{0,30}(per\s*day|daily|\/day)/i,
    factor: 1e5,
  },
];

function detectFix(key, metric) {
  if (!metric.quote) return null;
  for (const fix of UNIT_FIXES) {
    if (!fix.appliesTo.includes(key)) continue;
    if (fix.quoteRe.test(metric.quote)) return fix;
  }
  return null;
}

// Quote-PARSED fixes: extract the value from the quote text itself rather
// than transforming the stored (potentially mis-read) value. Used when the
// LLM's stored number is in an unpredictable unit but the quote has the
// canonical "X Cr per annum" form we can parse.
const QUOTE_PARSED_FIXES = [
  {
    name: 'ARPOB X Cr per annum → INR/day',
    appliesTo: ['arpob'],
    parse: (quote) => {
      const m = String(quote).match(/(?:INR|₹)?\s*([\d.]+)\s*(?:Cr|crore|Crore)\s+per\s+(?:annum|year|annual)/i);
      if (!m) return null;
      const crPerYear = Number(m[1]);
      if (!Number.isFinite(crPerYear) || crPerYear < 0.3 || crPerYear > 10) return null;
      return Math.round((crPerYear * 1e7) / 365);
    },
  },
];

function detectQuoteParsedFix(key, metric) {
  if (!metric.quote) return null;
  for (const fix of QUOTE_PARSED_FIXES) {
    if (!fix.appliesTo.includes(key)) continue;
    const newVal = fix.parse(metric.quote);
    if (newVal != null) return { fix, newVal };
  }
  return null;
}

function applyFix(value, factor) {
  return typeof factor === 'function' ? factor(value) : value * factor;
}

// Sanity ranges per metric (Indian hospital sector typical bounds).
// If a fix produces a value outside these, REJECT the fix.
const SANITY_RANGES = {
  revenue: [50, 30000],            // INR Cr quarterly
  ebitda: [-500, 10000],
  pat: [-2000, 5000],
  netDebt: [-10000, 30000],
  capexAnnounced: [0, 30000],
  arpob: [20000, 150000],          // INR per day
  arpp: [10000, 500000],           // INR per patient
};
function inRange(key, value) {
  const r = SANITY_RANGES[key];
  if (!r || value == null || !Number.isFinite(value)) return true;
  return value >= r[0] && value <= r[1];
}

// First pass: revert ANY existing unit-fix where the current value is now
// out of sanity range (i.e., a previous run's fix mis-applied).
async function revertBadFixes(slug) {
  const path = `data/extracted/${slug}.json`;
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { return 0; }
  let reverted = 0;
  for (const entry of Object.values(data.byNewsId || {})) {
    if (!entry.metrics) continue;
    for (const [key, m] of Object.entries(entry.metrics)) {
      if (!m.unitFixApplied || m.originalValue == null) continue;
      if (!inRange(key, m.value)) {
        m.value = m.originalValue;
        delete m.originalValue;
        delete m.unitFixApplied;
        reverted++;
      }
    }
  }
  if (reverted > 0) {
    await writeFile(path, JSON.stringify(data, null, 2));
  }
  return reverted;
}

async function processCompany(slug) {
  const path = `data/extracted/${slug}.json`;
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }

  let fixCount = 0;
  const fixesApplied = [];

  for (const entry of Object.values(data.byNewsId || {})) {
    if (!entry.metrics) continue;
    for (const [key, m] of Object.entries(entry.metrics)) {
      if (m.value == null) continue;
      if (m.unitFixApplied) continue; // already fixed in a prior pass

      // Try quote-parsed fix first (more reliable for messy LLM unit handling)
      const quoteFix = detectQuoteParsedFix(key, m);
      if (quoteFix) {
        const rounded = Math.round(quoteFix.newVal * 1000) / 1000;
        if (Math.abs(rounded - m.value) > 0.01 && inRange(key, rounded)) {
          m.originalValue = m.value;
          m.value = rounded;
          m.unitFixApplied = quoteFix.fix.name;
          fixCount++;
          fixesApplied.push({ doc: entry.docType, date: entry.date, metric: key, before: m.originalValue, after: m.value, fix: quoteFix.fix.name });
          continue;
        }
      }

      const fix = detectFix(key, m);
      if (!fix) continue;
      const newVal = applyFix(m.value, fix.factor);
      const rounded = Math.round(newVal * 1000) / 1000;
      if (Math.abs(rounded - m.value) < 0.01) continue;
      // SAFETY: skip if the corrected value would be wildly outside the
      // plausible range for this metric (e.g., misread units cascading).
      if (!inRange(key, rounded)) continue;
      m.originalValue = m.value;
      m.value = rounded;
      m.unitFixApplied = fix.name;
      fixCount++;
      fixesApplied.push({ doc: entry.docType, date: entry.date, metric: key, before: m.originalValue, after: m.value, fix: fix.name });
    }
  }

  if (fixCount > 0) {
    data.lastFixedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(data, null, 2));
  }
  return { fixCount, fixesApplied };
}

const companies = await loadCompanies();
console.error(`Scanning ${companies.length} companies for unit-conversion errors…\n`);

// First pass: revert any previously-applied fixes that produced out-of-range values
console.error('Pass 1 — reverting out-of-range previous fixes:');
let revertedTotal = 0;
for (const c of companies) {
  const n = await revertBadFixes(c.slug);
  if (n > 0) console.error(`  ${c.slug.padEnd(22)} reverted ${n}`);
  revertedTotal += n;
}
console.error(`  total reverted: ${revertedTotal}\n`);

// Second pass: apply fresh unit-conversion fixes with sanity guards
console.error('Pass 2 — applying unit conversions where quote indicates:');
let total = 0;
for (const c of companies) {
  const r = await processCompany(c.slug);
  if (r == null) {
    console.error(`  ${c.slug.padEnd(22)} no extraction file`);
    continue;
  }
  total += r.fixCount;
  console.error(`  ${c.slug.padEnd(22)} ${String(r.fixCount).padStart(3)} value(s) corrected`);
  for (const f of r.fixesApplied.slice(0, 3)) {
    console.error(`    · ${f.metric} ${f.before} → ${f.after} [${f.fix}]`);
  }
  if (r.fixesApplied.length > 3) console.error(`    · …+${r.fixesApplied.length - 3} more`);
}
console.error(`\nTotal corrections: ${total}`);
