import { useEffect, useMemo, useState } from 'react';
import { loadSectorData } from './lib/data';
import CompanyHeader from './components/CompanyHeader';
import Section from './components/Section';
import MetricDetailModal from './components/MetricDetailModal';
import PeriodSelector from './components/PeriodSelector';
import { defaultPeriod } from './lib/period';

// 6 sections matching Simran's framework
const SECTIONS = [
  { id: 'network',         title: 'Network & infrastructure',  subtitle: 'Size and reach',
    metrics: ['numberOfHospitals', 'bedCapacity', 'operationalBeds', 'vacantBeds', 'bedUtilizationPct', 'bedsPerHospital', 'bedsUnderDevelopment', 'newHospitalsPlanned'] },
  { id: 'operations',      title: 'Operational efficiency',    subtitle: 'Productivity & throughput',
    metrics: ['occupancyRate', 'alos', 'ipVolume', 'opVolume', 'bedTurnoverQuarter'] },
  { id: 'revenueQuality',  title: 'Revenue quality',           subtitle: 'Pricing power per bed & patient',
    metrics: ['arpob', 'arpp', 'revenuePerBedQuarter', 'revenueGrowthYoy', 'revenueCagr3yr'] },
  { id: 'profitability',   title: 'Profitability & returns',   subtitle: 'Margin & capital efficiency',
    metrics: ['revenue', 'revenueTtmCr', 'ebitda', 'ebitdaTtmCr', 'ebitdaMargin', 'pat', 'patTtmCr', 'patMargin', 'ebitdaPerBedQuarter', 'roce'] },
  { id: 'expansion',       title: 'Expansion & capital',       subtitle: 'Growth trajectory & leverage',
    metrics: ['capexAnnounced', 'netDebt', 'netDebtToEbitda'] },
  { id: 'valuation',       title: 'Valuation',                 subtitle: 'What the market pays',
    metrics: ['enterpriseValueCr', 'evToEbitda', 'evPerBedLakhs', 'peTtm'] },
];

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [slug, setSlug] = useState(null);
  const [selectedMetric, setSelectedMetric] = useState(null);
  const [period, setPeriod] = useState(null);

  useEffect(() => {
    loadSectorData()
      .then((d) => {
        setData(d);
        // Pick the first company with any data
        const firstWithData = d.companies.find((c) => {
          const co = d.byCompany[c.slug];
          return co && Object.keys(co.quarters || {}).length > 0;
        });
        setSlug(firstWithData?.slug || d.companies[0]?.slug);
      })
      .catch((e) => setError(e.message));
  }, []);

  const company = data && slug ? data.byCompany[slug] : null;

  // Reset period to that company's latest quarter when switching companies
  useEffect(() => {
    if (company) setPeriod(defaultPeriod(company));
  }, [slug, data]);
  const buildDate = useMemo(() => (data ? new Date(data.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''), [data]);

  if (error) {
    return (
      <div className="app">
        <div className="empty">Failed to load sector data: {error}</div>
      </div>
    );
  }
  if (!data) {
    return <div className="app"><div className="empty">Loading sector data…</div></div>;
  }

  const cosWithData = data.companies.filter((c) => {
    const co = data.byCompany[c.slug];
    return co && Object.keys(co.quarters || {}).length > 0;
  });

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          Hospital Sector Dashboard <span>· India</span>
        </h1>
        <div className="meta">
          <span><strong>{data.companies.length}</strong> companies tracked</span>
          <span><strong>{cosWithData.length}</strong> with extracted data</span>
          <span><strong>{data.quarters.length}</strong> quarters</span>
          <span>Built {buildDate}</span>
        </div>
      </div>

      {cosWithData.length < data.companies.length && (
        <div className="banner">
          <span>⏳</span>
          <div>
            <strong>Backfill in progress.</strong> {cosWithData.length}/{data.companies.length} companies have extracted metrics so far. Daily extraction runs are populating the rest — peer rankings and sector comparisons will sharpen as data lands.
          </div>
        </div>
      )}

      <div className="switcher">
        {data.companies.map((c) => {
          const hasData = data.byCompany[c.slug]?.quarters && Object.keys(data.byCompany[c.slug].quarters).length > 0;
          return (
            <button
              key={c.slug}
              onClick={() => setSlug(c.slug)}
              className={slug === c.slug ? 'active' : ''}
              disabled={!hasData}
              style={!hasData ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              title={hasData ? c.name : `${c.name} (no extracted data yet)`}
            >
              {c.shortName || c.name}
              {!hasData && <span style={{ marginLeft: 6, fontSize: 9 }}>—</span>}
            </button>
          );
        })}
      </div>

      <CompanyHeader company={company} />

      {company && Object.keys(company.quarters || {}).length > 0 ? (
        <>
          <PeriodSelector company={company} selected={period} onChange={setPeriod} />
          {SECTIONS.map((s) => (
            <Section
              key={s.id}
              {...s}
              sectorData={data}
              companySlug={slug}
              period={period}
              onSelectMetric={setSelectedMetric}
            />
          ))}
        </>
      ) : (
        <div className="empty">
          No extracted metrics yet for {company?.name || 'this company'}. Run the Gemini extraction workflow to populate.
        </div>
      )}

      <MetricDetailModal
        open={!!selectedMetric}
        onClose={() => setSelectedMetric(null)}
        metricKey={selectedMetric}
        meta={selectedMetric ? data.metricMeta?.[selectedMetric] : null}
        sectorData={data}
        companySlug={slug}
      />

      <footer>
        <div>
          Data: BSE corporate filings + investor presentations · Extraction: Gemini 2.5 Flash · No hardcoded values
        </div>
        <div>
          <a href="https://github.com/ceekay-munshot/hospitaldash" target="_blank" rel="noreferrer">Source</a>
        </div>
      </footer>
    </div>
  );
}
