// Indian-style number formatting (12,34,567 not 1,234,567)
const inIN = new Intl.NumberFormat('en-IN');

export function fmtIndianNumber(n, opts = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const { maximumFractionDigits = 0 } = opts;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits }).format(n);
}

export function formatValue(value, unit) {
  if (value == null || !Number.isFinite(value)) return { display: '—', unitLabel: '' };

  switch (unit) {
    case 'INR Cr':
      if (Math.abs(value) >= 100000) {
        return { display: `₹${(value / 100000).toFixed(2)}L`, unitLabel: 'Cr' };
      }
      return { display: `₹${fmtIndianNumber(value, { maximumFractionDigits: value < 100 ? 1 : 0 })}`, unitLabel: 'Cr' };
    case '%':
      return { display: `${value.toFixed(1)}`, unitLabel: '%' };
    case 'INR/day':
    case 'INR/patient':
      return { display: `₹${fmtIndianNumber(value)}`, unitLabel: unit === 'INR/day' ? '/day' : '/patient' };
    case 'INR/bed':
      // value is annual rupees per bed; show as lakhs
      return { display: `₹${(value / 100000).toFixed(1)}L`, unitLabel: '/bed/yr' };
    case 'INR Cr/bed':
      return { display: value.toFixed(2), unitLabel: '₹Cr/bed' };
    case '₹ lakh/bed':
      return { display: `₹${value.toFixed(1)}L`, unitLabel: '/bed' };
    case 'days':
      return { display: value.toFixed(2), unitLabel: 'days' };
    case 'x':
      return { display: `${value.toFixed(1)}x`, unitLabel: '' };
    case 'count':
      return { display: fmtIndianNumber(value), unitLabel: '' };
    case 'admissions':
    case 'visits':
      return { display: fmtIndianNumber(value), unitLabel: unit };
    case 'admits/bed/yr':
      return { display: value.toFixed(1), unitLabel: 'turns/yr' };
    default:
      return { display: typeof value === 'number' ? fmtIndianNumber(value) : String(value), unitLabel: unit || '' };
  }
}

export function percentDelta(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function fmtDelta(deltaPct) {
  if (deltaPct == null) return '';
  const sign = deltaPct > 0 ? '+' : '';
  const abs = Math.abs(deltaPct);
  if (abs >= 100) return `${sign}${Math.round(deltaPct)}%`;
  if (abs >= 10) return `${sign}${deltaPct.toFixed(1)}%`;
  return `${sign}${deltaPct.toFixed(2)}%`;
}
