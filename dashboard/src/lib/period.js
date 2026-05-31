// Resolve the active view (metric map) for a (company, period) selection.

export function resolveView(company, period) {
  if (!company || !period) return null;
  if (period.kind === 'quarter') {
    const q = company.quarters?.[period.target];
    return q ? { metrics: q.metrics, sources: q.sources, label: q.label } : null;
  }
  if (period.kind === 'ttm') {
    const v = company.periodViews?.ttm?.[period.target];
    return v ? { metrics: v.metrics, sources: [], label: v.label } : null;
  }
  if (period.kind === 'fy') {
    const v = company.periodViews?.fy?.[period.target];
    return v ? { metrics: v.metrics, sources: [], label: v.label } : null;
  }
  return null;
}

// Default period for a company — prefer latest quarter (most native, fewest assumptions)
export function defaultPeriod(company) {
  if (!company) return null;
  if (company.latestQuarter) {
    const label = company.quarters?.[company.latestQuarter]?.label || company.latestQuarter;
    return { key: `quarter:${company.latestQuarter}`, kind: 'quarter', target: company.latestQuarter, label };
  }
  return null;
}
