// Quarter normalization, best-extraction picking, derived metric formulas

const FY_RE_A = /Q\s*([1-4])\s*[\/\-,\s]+FY\s*(\d{2,4})/i; // "Q3 FY26"
const FY_RE_B = /FY\s*(\d{2,4})\s*[\/\-,\s]+Q\s*([1-4])/i; // "FY26-Q3"

export function normalizeQuarter(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (/^FY\d{2}-Q[1-4]$/.test(s)) return s;
  let m = s.match(FY_RE_A);
  if (m) {
    const q = m[1];
    let fy = parseInt(m[2], 10);
    if (fy < 100) fy = 2000 + fy;
    return `FY${String(fy % 100).padStart(2, '0')}-Q${q}`;
  }
  m = s.match(FY_RE_B);
  if (m) {
    let fy = parseInt(m[1], 10);
    if (fy < 100) fy = 2000 + fy;
    const q = m[2];
    return `FY${String(fy % 100).padStart(2, '0')}-Q${q}`;
  }
  return null;
}

export function quarterRange(fq) {
  const m = /^FY(\d{2})-Q([1-4])$/.exec(fq || '');
  if (!m) return null;
  const fy = 2000 + Number(m[1]);
  const q = Number(m[2]);
  const ranges = {
    1: { from: `${fy - 1}-04-01`, to: `${fy - 1}-06-30`, calendar: `Apr–Jun ${fy - 1}` },
    2: { from: `${fy - 1}-07-01`, to: `${fy - 1}-09-30`, calendar: `Jul–Sep ${fy - 1}` },
    3: { from: `${fy - 1}-10-01`, to: `${fy - 1}-12-31`, calendar: `Oct–Dec ${fy - 1}` },
    4: { from: `${fy}-01-01`, to: `${fy}-03-31`, calendar: `Jan–Mar ${fy}` },
  };
  return { label: `Q${q} FY${m[1]}`, fy, q, ...ranges[q] };
}

// Sort quarter keys chronologically (oldest first)
export function compareQuarters(a, b) {
  const ma = /^FY(\d{2})-Q([1-4])$/.exec(a);
  const mb = /^FY(\d{2})-Q([1-4])$/.exec(b);
  if (!ma || !mb) return String(a).localeCompare(String(b));
  if (ma[1] !== mb[1]) return Number(ma[1]) - Number(mb[1]);
  return Number(ma[2]) - Number(mb[2]);
}

// ── Best-extraction picker ──────────────────────────────────────────────
const DOC_PRIORITY = {
  'investor-presentation': 4,
  'quarterly-result': 3,
  'concall-transcript': 2,
  'press-release': 1,
};
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

export function pickBestForMetric(extractions, metricKey) {
  let best = null;
  for (const ext of extractions) {
    const m = ext.metrics?.[metricKey];
    if (!m || m.value == null) continue;

    const confRank = CONFIDENCE_RANK[m.confidence] || 0;
    const docPref = DOC_PRIORITY[ext.docType] || 0;

    if (!best) {
      best = { metric: m, ext, confRank, docPref };
      continue;
    }
    // Higher confidence wins
    if (confRank > best.confRank) {
      best = { metric: m, ext, confRank, docPref };
      continue;
    }
    if (confRank === best.confRank && docPref > best.docPref) {
      best = { metric: m, ext, confRank, docPref };
    }
  }
  if (!best) return null;
  return {
    value: best.metric.value,
    unit: best.metric.unit,
    confidence: best.metric.confidence,
    quote: best.metric.quote,
    source: {
      docType: best.ext.docType,
      newsId: best.ext.newsId,
      date: best.ext.date,
      pdfUrl: best.ext.pdfUrl,
    },
  };
}

// ── Derived metric calculators ──────────────────────────────────────────
// Annualize quarterly P&L numbers (revenue, ebitda, pat are reported per quarter in INR Cr)
const annualize = (qVal) => (qVal == null ? null : qVal * 4);

export function deriveMetrics({ metrics, marketCapCr }) {
  const get = (k) => (metrics[k]?.value != null ? metrics[k].value : null);

  const revenueCr = get('revenue');
  const ebitdaCr = get('ebitda');
  const patCr = get('pat');
  const netDebtCr = get('netDebt');
  const opBeds = get('operationalBeds');
  const totalBeds = get('bedCapacity');
  const ipVol = get('ipVolume');
  const opVol = get('opVolume');
  const occupancy = get('occupancyRate');
  const arpob = get('arpob');

  const derived = {};

  // Asset productivity (annualised)
  if (revenueCr != null && opBeds) {
    // (revenue × 4 quarters × 10^7 INR/Cr) / beds → INR per bed per year
    derived.revenuePerBedYearly = Math.round((revenueCr * 4 * 1e7) / opBeds);
  }
  if (ebitdaCr != null && opBeds) {
    derived.ebitdaPerBedYearly = Math.round((ebitdaCr * 4 * 1e7) / opBeds);
  }
  if (ipVol != null && opBeds) {
    derived.bedTurnoverYearly = Number(((ipVol * 4) / opBeds).toFixed(2));
  }
  if (totalBeds && opBeds) {
    derived.bedActivationPct = Number(((opBeds / totalBeds) * 100).toFixed(1));
  }

  // Valuation (needs market cap from quotes)
  if (marketCapCr != null) {
    const ev = marketCapCr + (netDebtCr ?? 0);
    derived.enterpriseValueCr = Number(ev.toFixed(1));
    if (ebitdaCr != null && ebitdaCr !== 0) {
      derived.evToEbitdaAnnualised = Number((ev / (ebitdaCr * 4)).toFixed(2));
    }
    if (patCr != null && patCr > 0) {
      derived.peAnnualised = Number((marketCapCr / (patCr * 4)).toFixed(2));
    }
    if (opBeds) {
      // EV per bed in INR Cr per bed
      derived.evPerBedCr = Number((ev / opBeds).toFixed(3));
      // Also expose in lakhs for readability
      derived.evPerBedLakhs = Number(((ev * 100) / opBeds).toFixed(1));
    }
  }

  // PAT margin (per-quarter calculation)
  if (patCr != null && revenueCr != null && revenueCr > 0) {
    derived.patMargin = Number(((patCr / revenueCr) * 100).toFixed(2));
  }

  // ARPOB derivation removed: revenue here is consolidated (includes pharmacy/
  // diagnostics for Apollo, Aster etc.), so dividing by hospital beds × occupancy
  // overstates hospital-only ARPOB. Direct ARPOB extraction is far more reliable.

  return derived;
}

// ── Override merger ─────────────────────────────────────────────────────
// Overrides shape (per quarter):
//   { "FY26-Q4": { "occupancyRate": { "value": 67.5, "note": "…", "source": "…" } } }
export function applyOverrides(metrics, overridesForQuarter) {
  if (!overridesForQuarter) return metrics;
  const out = { ...metrics };
  for (const [key, override] of Object.entries(overridesForQuarter)) {
    if (!override || typeof override !== 'object') continue;
    out[key] = {
      value: override.value ?? null,
      unit: out[key]?.unit ?? '',
      confidence: 'high',
      quote: override.source ?? '',
      overridden: true,
      override: { note: override.note ?? null, source: override.source ?? null },
      source: out[key]?.source ?? null,
    };
  }
  return out;
}

// ── Statistics ───────────────────────────────────────────────────────────
export function stats(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v));
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    n: nums.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
  };
}
