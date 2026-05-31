// Period selector — Simran's #1 feature ask.
// Pills: Quarter | TTM | FY26 | FY25 | FY24
// Per Simran: "my whole dashboard should change figures based on the time period I choose"
import { useMemo } from 'react';

export default function PeriodSelector({ company, selected, onChange }) {
  const options = useMemo(() => {
    if (!company) return [];
    const out = [];
    if (company.latestQuarter) {
      out.push({
        key: `quarter:${company.latestQuarter}`,
        kind: 'quarter',
        target: company.latestQuarter,
        label: company.quarters?.[company.latestQuarter]?.label || company.latestQuarter,
        sub: 'single quarter',
      });
    }
    if (company.latestTtm && company.periodViews?.ttm?.[company.latestTtm]) {
      out.push({
        key: `ttm:${company.latestTtm}`,
        kind: 'ttm',
        target: company.latestTtm,
        label: 'TTM',
        sub: 'trailing 12 months',
      });
    }
    // FYs newest first
    const fyKeys = Object.keys(company.periodViews?.fy || {}).sort().reverse();
    for (const k of fyKeys) {
      const fyv = company.periodViews.fy[k];
      out.push({
        key: `fy:${k}`,
        kind: 'fy',
        target: k,
        label: fyv.label || k,
        sub: fyv.complete ? 'full year' : `${fyv.quartersUsed}Q partial`,
      });
    }
    return out;
  }, [company]);

  if (!options.length) return null;

  return (
    <div className="period-selector">
      <span className="period-label">View as:</span>
      <div className="period-pills">
        {options.map((opt) => (
          <button
            key={opt.key}
            className={`period-pill ${selected?.key === opt.key ? 'active' : ''}`}
            onClick={() => onChange(opt)}
            title={opt.sub}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
