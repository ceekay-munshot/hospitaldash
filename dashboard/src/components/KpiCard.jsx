import Sparkline from './Sparkline';
import { formatValue, percentDelta, fmtDelta } from '../lib/format';
import { timeSeries } from '../lib/data';

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

export default function KpiCard({ metricKey, meta, companyData, rank, totalCos, onClick }) {
  const series = timeSeries(companyData, metricKey);
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  const change = latest && prev ? percentDelta(latest.value, prev.value) : null;
  const formatted = formatValue(latest?.value, meta.unit);

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

      {latest ? (
        <>
          <div className="value">
            <span>{formatted.display}</span>
            {formatted.unitLabel && <span className="unit">{formatted.unitLabel}</span>}
          </div>
          {change != null && (
            <div className={`change ${changeClass}`}>
              {fmtDelta(change)} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>vs {prev.label}</span>
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
