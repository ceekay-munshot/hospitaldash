import { useEffect, useMemo, useState } from 'react';
import TrendChart from './TrendChart';
import { formatValue } from '../lib/format';

const TIME_RANGES = [
  { label: 'Last 4Q', n: 4 },
  { label: 'Last 8Q', n: 8 },
  { label: 'All', n: null },
];

export default function MetricDetailModal({ open, onClose, metricKey, meta, sectorData, companySlug }) {
  const [rangeIdx, setRangeIdx] = useState(2); // default: All
  const [showPeers, setShowPeers] = useState(true);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Reset filters when switching metric
  useEffect(() => { setRangeIdx(2); }, [metricKey]);

  const { primary, peers, allQuarters } = useMemo(() => {
    if (!open || !sectorData || !metricKey || !companySlug) return { primary: null, peers: [], allQuarters: [] };

    const range = TIME_RANGES[rangeIdx].n;
    const allFqs = sectorData.quarters;
    const slicedFqs = range ? allFqs.slice(-range) : allFqs;

    const buildSeries = (slug) => {
      const co = sectorData.byCompany[slug];
      if (!co?.quarters) return null;
      const series = slicedFqs
        .map((fq) => {
          const q = co.quarters[fq];
          if (!q) return null;
          const value = q.metrics?.[metricKey];
          if (value == null) return null;
          return {
            fq,
            label: q.label || fq,
            value,
            sources: q.sources || [],
          };
        })
        .filter(Boolean);
      if (series.length === 0) return null;
      return {
        slug,
        name: co.name,
        shortName: co.shortName || co.name,
        series,
      };
    };

    const primary = buildSeries(companySlug);
    const peers = [];
    if (showPeers && sectorData.companies) {
      for (const c of sectorData.companies) {
        if (c.slug === companySlug) continue;
        const s = buildSeries(c.slug);
        if (s) peers.push(s);
      }
    }
    return { primary, peers, allQuarters: slicedFqs };
  }, [open, sectorData, metricKey, companySlug, rangeIdx, showPeers]);

  if (!open || !metricKey || !meta) return null;
  if (!primary) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <div className="modal-title">{meta.label}</div>
              <div className="modal-sub">No data for selected company</div>
            </div>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>
      </div>
    );
  }

  // Build rank info from sectorData.rankings
  const latestFq = primary.series[primary.series.length - 1]?.fq;
  const rankList = latestFq ? sectorData.rankings?.[latestFq]?.[metricKey] : null;
  const myRank = rankList?.find((r) => r.slug === companySlug);

  const aggregates = latestFq ? sectorData.sectorAggregates?.[latestFq]?.[metricKey] : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{meta.label}</div>
            <div className="modal-sub">
              {sectorData.byCompany[companySlug]?.name}
              {myRank && rankList && <> · Rank #{myRank.rank} of {rankList.length}</>}
              {aggregates && (
                <> · Sector median {formatValue(aggregates.median, meta.unit).display}
                  {formatValue(aggregates.median, meta.unit).unitLabel}
                </>
              )}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-toolbar">
          <div className="seg">
            {TIME_RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRangeIdx(i)}
                className={i === rangeIdx ? 'active' : ''}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            className={`toggle ${showPeers ? 'active' : ''}`}
            onClick={() => setShowPeers((v) => !v)}
            title="Toggle peer overlay"
          >
            {showPeers ? '✓ ' : ''}Compare all peers ({peers.length})
          </button>
        </div>

        <TrendChart
          metricKey={metricKey}
          meta={meta}
          primaryCompany={primary}
          peerCompanies={showPeers ? peers : []}
          height={420}
        />

        <div className="modal-body">
          <div className="qtable-wrap">
            <table className="qtable">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th>Value</th>
                  <th>QoQ</th>
                  {peers.length > 0 && showPeers && <th>Sector median</th>}
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {primary.series.slice().reverse().map((point, idx, arr) => {
                  const prev = arr[idx + 1];
                  const qoq = prev ? ((point.value - prev.value) / Math.abs(prev.value)) * 100 : null;
                  const fmt = formatValue(point.value, meta.unit);
                  const med = sectorData.sectorAggregates?.[point.fq]?.[metricKey]?.median;
                  const medFmt = med != null ? formatValue(med, meta.unit) : null;
                  return (
                    <tr key={point.fq}>
                      <td>{point.label}</td>
                      <td className="tnum strong">{fmt.display}{fmt.unitLabel && <span className="unit">{fmt.unitLabel}</span>}</td>
                      <td className={`tnum ${qoq == null ? '' : (meta.higherIsBetter ? (qoq > 0 ? 'pos' : 'neg') : (qoq < 0 ? 'pos' : 'neg'))}`}>
                        {qoq == null ? '—' : `${qoq > 0 ? '+' : ''}${qoq.toFixed(qoq < 10 ? 1 : 0)}%`}
                      </td>
                      {peers.length > 0 && showPeers && (
                        <td className="tnum">
                          {medFmt ? `${medFmt.display}${medFmt.unitLabel}` : '—'}
                        </td>
                      )}
                      <td>
                        {point.sources.length > 0 ? (
                          <div className="src-chips">
                            {point.sources.slice(0, 3).map((s, i) => (
                              <a
                                key={i}
                                href={s.pdfUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={`${s.docType} · ${s.date}`}
                                className="src-chip"
                              >
                                {s.docType.replace('-', ' ')}
                              </a>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
