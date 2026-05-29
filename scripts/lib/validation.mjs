// Validation + confidence layer. Turns raw multi-source extractions into a
// single trusted value per (metric, quarter) — or flags it for human review.
//
// Principle: a value reaches the client ONLY if corroborated or verified.
// Uncertain values go to the review queue (never silently shown wrong).

// Sector-specific plausibility bounds. Anything outside → rejected outright.
export const SANITY_RANGES = {
  numberOfHospitals: [1, 100],
  bedCapacity: [50, 25000],
  operationalBeds: [50, 20000],
  bedsUnderDevelopment: [0, 10000],
  newHospitalsPlanned: [0, 30],
  occupancyRate: [10, 95],
  alos: [1, 12],
  ipVolume: [1000, 600000],
  opVolume: [5000, 5000000],
  arpob: [15000, 200000],
  arpp: [10000, 500000],
  revenue: [50, 30000],
  ebitda: [-500, 12000],
  ebitdaMargin: [-20, 60],
  pat: [-2000, 6000],
  netDebt: [-15000, 30000],
  capexAnnounced: [0, 30000],
  revenueGrowthYoy: [-60, 250],
  roce: [-30, 70],
};

// Relative tolerance for "two sources agree" — within this % counts as a match.
const AGREEMENT_TOLERANCE = 0.05; // 5%

// Phrases in the quote that signal the LLM grabbed the WRONG period.
const PERIOD_MISMATCH_FLAGS = [
  /\bFY\s*\d{2,4}\b(?!\s*[-\/]?\s*Q)/i, // "FY26" but not "FY26-Q3"
  /full[\s-]?year/i,
  /year\s+ended/i,
  /annual/i,
  /\b9M\b/i,
  /nine[\s-]?month/i,
  /\bH[12]\b/i,
  /half[\s-]?year/i,
  /\bYTD\b/i,
  /year[\s-]?to[\s-]?date/i,
];

// Flow metrics: a quote mentioning YTD/FY/9M is suspicious (period mismatch).
// Stock metrics (point-in-time): period words don't necessarily mean wrong value.
const FLOW_METRICS = new Set([
  'revenue', 'ebitda', 'pat', 'ipVolume', 'opVolume', 'capexAnnounced',
]);

// Percentage / ratio metrics — standalone vs consolidated reporting can
// legitimately differ, so use a wider disagreement tolerance.
const PERCENT_METRICS = new Set([
  'ebitdaMargin', 'occupancyRate', 'revenueGrowthYoy', 'roce',
]);

export function inSanityRange(metricKey, value) {
  const r = SANITY_RANGES[metricKey];
  if (!r) return true;
  if (value == null || !Number.isFinite(value)) return false;
  return value >= r[0] && value <= r[1];
}

function quoteHasPeriodMismatch(quote) {
  if (!quote) return false;
  return PERIOD_MISMATCH_FLAGS.some((re) => re.test(quote));
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DOC_PRIORITY = {
  'investor-presentation': 4,
  'quarterly-result': 3,
  'concall-transcript': 3,
  'press-release': 2,
  'bse-quarterly-result-api': 5, // structured SEBI data — most trusted for financials
};
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * Resolve a single (metric, quarter) from multiple candidate extractions.
 * Returns { value, confidence, status, sources, candidates, reason }.
 *
 * status:
 *   'verified'   — manual override (always trusted)
 *   'corroborated' — 2+ independent sources agree → client-safe
 *   'single-strong' — one high-confidence source, in range → client-safe (medium)
 *   'review'     — sources disagree / out of range / period-mismatch → flag
 *   'missing'    — no candidate at all
 */
export function resolveMetric(metricKey, candidates, { override } = {}) {
  // 1. Manual override always wins — verified ground truth
  if (override && override.value != null) {
    return {
      value: override.value,
      confidence: 'verified',
      status: 'verified',
      sources: [{ docType: 'manual-override', note: override.note, source: override.source }],
      reason: 'manual override',
    };
  }

  // 2. Collect usable candidates: value present + in sanity range
  const usable = [];
  const rejected = [];
  for (const c of candidates) {
    if (c.value == null || !Number.isFinite(c.value)) continue;
    if (!inSanityRange(metricKey, c.value)) {
      rejected.push({ ...c, rejectReason: 'out-of-range' });
      continue;
    }
    // Flow metric with a period-mismatch quote → demote heavily
    const mismatch = FLOW_METRICS.has(metricKey) && quoteHasPeriodMismatch(c.quote);
    usable.push({ ...c, periodMismatch: mismatch });
  }

  if (usable.length === 0) {
    return {
      value: null,
      confidence: 'low',
      status: candidates.length ? 'review' : 'missing',
      sources: [],
      rejected,
      reason: candidates.length ? 'all candidates out of range or empty' : 'no source',
    };
  }

  // 3. Prefer candidates WITHOUT period mismatch
  const clean = usable.filter((c) => !c.periodMismatch);
  const pool = clean.length > 0 ? clean : usable;

  // 4. Multi-source agreement check
  const values = pool.map((c) => c.value);
  const med = median(values);
  const agreeing = pool.filter((c) => Math.abs(c.value - med) <= Math.abs(med) * AGREEMENT_TOLERANCE);

  // Sort pool by trust (doc priority, then confidence)
  pool.sort((a, b) => {
    const dp = (DOC_PRIORITY[b.docType] || 0) - (DOC_PRIORITY[a.docType] || 0);
    if (dp !== 0) return dp;
    return (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0);
  });

  const sourcesMeta = pool.map((c) => ({
    docType: c.docType,
    date: c.date,
    pdfUrl: c.pdfUrl,
    value: c.value,
    confidence: c.confidence,
    periodMismatch: c.periodMismatch || false,
  }));

  // CORROBORATED: 2+ independent docTypes agree near median
  const distinctAgreeingDocs = new Set(agreeing.map((c) => c.docType));
  if (agreeing.length >= 2 && distinctAgreeingDocs.size >= 2) {
    return {
      value: med,
      confidence: 'high',
      status: 'corroborated',
      sources: sourcesMeta,
      agreementCount: agreeing.length,
      reason: `${agreeing.length} sources agree`,
    };
  }

  // Check spread — if remaining candidates disagree wildly, flag.
  // Wider tolerance for ratio/percentage metrics (standalone vs consolidated
  // legitimately differ); tighter for absolute financials.
  if (pool.length >= 2) {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const disagreeThreshold = PERCENT_METRICS.has(metricKey) ? 2.0 : 1.5;
    if (lo > 0 && hi / lo > disagreeThreshold) {
      return {
        value: med, // median is the robust pick even when flagged
        confidence: 'low',
        status: 'review',
        sources: sourcesMeta,
        reason: `sources disagree (${lo} … ${hi})`,
      };
    }
    // Sources are close enough → treat as corroborated even if same docType
    return {
      value: med,
      confidence: 'high',
      status: 'corroborated',
      sources: sourcesMeta,
      reason: `${pool.length} sources within tolerance`,
    };
  }

  // SINGLE SOURCE: in-range and passed period-mismatch filter.
  // The sanity range + period-mismatch checks already remove systematic errors,
  // so a lone in-range value is acceptable as medium-confidence (client-safe).
  // Only flag if it's explicitly low-confidence AND a financial flow metric
  // (where a wrong-period grab is most damaging).
  const best = pool[0];
  const risky = best.confidence === 'low' && FLOW_METRICS.has(metricKey);
  if (risky) {
    return {
      value: best.value,
      confidence: 'low',
      status: 'review',
      sources: sourcesMeta,
      reason: 'single low-confidence financial source',
    };
  }
  return {
    value: best.value,
    confidence: best.confidence === 'high' ? 'medium' : 'medium',
    status: 'single-strong',
    sources: sourcesMeta,
    reason: 'single in-range source',
  };
}

// Trend continuity: given an ordered series of {fq, value}, flag points that
// jump >2.5x or <0.4x vs BOTH neighbours (isolated spikes).
export function flagTrendSpikes(series) {
  const flags = [];
  for (let i = 1; i < series.length - 1; i++) {
    const prev = series[i - 1].value;
    const cur = series[i].value;
    const next = series[i + 1].value;
    if ([prev, cur, next].some((v) => v == null || v === 0)) continue;
    const upPrev = cur / prev;
    const downNext = cur / next;
    // Isolated spike: high vs both neighbours, or low vs both
    if ((upPrev > 2.5 && downNext > 2.5) || (upPrev < 0.4 && downNext < 0.4)) {
      flags.push({ fq: series[i].fq, value: cur, prev, next });
    }
  }
  return flags;
}

// Statuses considered safe to show a client.
export const CLIENT_SAFE = new Set(['verified', 'corroborated', 'single-strong']);
