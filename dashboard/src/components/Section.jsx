import KpiCard from './KpiCard';

const SECTION_ICONS = {
  network: '🏥',
  operations: '⚡',
  revenueQuality: '₹',
  financials: '📊',
  profitability: '📈',
  expansion: '🏗',
  balanceSheet: '⚖',
  valuation: '🏷',
};

export default function Section({ id, title, subtitle, metrics, sectorData, companySlug, period, onSelectMetric }) {
  if (!metrics.length) return null;
  const companyData = sectorData.byCompany[companySlug];
  if (!companyData) return null;

  // For ranking, find the latest quarter where this co has each metric
  const latestQuarter = sectorData.latestQuarter;
  const ranks = {};
  for (const key of metrics) {
    const rankList = sectorData.rankings?.[latestQuarter]?.[key];
    if (rankList) {
      const entry = rankList.find((r) => r.slug === companySlug);
      if (entry) ranks[key] = { rank: entry.rank, total: rankList.length };
    }
  }

  return (
    <section className="section" data-color={id}>
      <div className="section-header" data-color={id}>
        <div className="section-icon">{SECTION_ICONS[id] || '•'}</div>
        <div className="section-title">{title}</div>
        {subtitle && <div className="section-sub">{subtitle}</div>}
      </div>
      <div className="kpi-grid">
        {metrics.map((key) => {
          const meta = sectorData.metricMeta?.[key];
          if (!meta) return null;
          return (
            <KpiCard
              key={key}
              metricKey={key}
              meta={meta}
              companyData={companyData}
              period={period}
              rank={ranks[key]?.rank}
              totalCos={ranks[key]?.total}
              onClick={() => onSelectMetric?.(key)}
            />
          );
        })}
      </div>
    </section>
  );
}
