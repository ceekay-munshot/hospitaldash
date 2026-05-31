import Sparkline from './Sparkline';
import { formatValue, percentDelta, fmtDelta } from '../lib/format';
import { timeSeries } from '../lib/data';
import { resolveView } from '../lib/period';

// Stock metrics — point-in-time, same value across periods (don't show delta on period switch).
const STOCK_METRICS = new Set([
  'numberOfHospitals', 'bedCapacity', 'operationalBeds', 'bedsUnderDevelopment',
  'newHospitalsPlanned', 'occupancyRate', 'arpob', 'arpp', 'alos',
  'netDebt', 'enterpriseValueCr', 'evToEbitda', 'evPerBedLakhs', 'peTtm', 'roce',
]);

const SECTION_COLOR = {
  network: '#0F6E56',
  operations: '#047857',
  revenueQuality: '#185FA5',
  financials: '#185FA5',
  profitability: '#1E40AF',
  expansion: '#534AB7',
  balanceSheet: '#534AB7',
  valuation: '#6D28D9',
};

export default function KpiCard({ metricKey, meta, companyData, period, rank, totalCos, onClick }) {
  // Sparkline always shows quarterly trend (history visualization)
  const series = timeSeries(companyData, metricKey);

  // The CURRENT value displayed depends on the selected period
  let currentValue;
  let periodLabel;
  if (period) {
    const view = resolveView(companyData, period);
    currentValue = view?.metrics?.[metricKey];
    periodLabel = view?.label;
  }
  // Fallback to series latest if no period view
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  if (currentValue == null) currentValue = latest?.value;

  // Period-aware delta — for stock metrics show QoQ vs prior quarter (always meaningful)
  // For flow metrics show prior comparable period only when quarter is selected
  let change = null;
  let deltaLabel = '';
  if (period?.kind === 'quarter' && latest && prev) {
    change = percentDelta(latest.value, prev.value);
    deltaLabel = `vs ${prev.label}`;
  } else if (STOCK_METRICS.has(metricKey) && latest && prev) {
    // Stock metrics: show QoQ even in TTM/FY view (point-in-time comparison still meaningful)
    change = percentDelta(latest.value, prev.value);
    deltaLabel = `vs ${prev.label}`;
  }

  const formatted = formatValue(currentValue, meta.unit);

  const color = SECTION_COLOR[meta.section] || '#52525b';

  let changeClass = 'neutral';
  if (change != null) {
    // For "lower is better" metrics, invert the color
    const lowerBetter = !meta.higherIsBetter;
    const good = lowerBetter ? change < 0 : change > 0;
    changeClass = good ? 'positive' : 'negative';
  }

  const isRanked = rank && totalCos && totalCos > 1;
  const isTop = isRanked && rank === 1;

  return (
    <button
      type="button"
      className="kpi-card kpi-card--clickable"
      data-color={meta.section}
      onClick={onClick}
      aria-label={`View trend for ${meta.label}`}
    >
      <div className="zoom-hint" aria-hidden>⤢</div>
      {isRanked && (
        <div className={`rank ${isTop ? 'top' : ''}`}>
          #{rank} of {totalCos}
        </div>
      )}
      <div className="label">{meta.label}</div>

      {currentValue != null ? (
        <>
          <div className="value">
            <span>{formatted.display}</span>
            {formatted.unitLabel && <span className="unit">{formatted.unitLabel}</span>}
          </div>
          {change != null && (
            <div className={`change ${changeClass}`}>
              {fmtDelta(change)} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{deltaLabel}</span>
            </div>
          )}
        </>
      ) : (
        <div className="value muted">—</div>
      )}

      <div className="spark">
        <Sparkline series={series} color={color} />
      </div>
    </button>
  );
}
