import { fmtIndianNumber, fmtDelta } from '../lib/format';

export default function CompanyHeader({ company }) {
  if (!company) return null;
  const q = company.latestQuote;
  const cov = company.coverage;
  const changeClass = q?.changePct == null ? '' : q.changePct >= 0 ? 'positive' : 'negative';

  return (
    <div className="coheader">
      <div className="name">
        <div className="full">{company.name}</div>
        <div className="sub">
          {company.ticker ? `${company.ticker} · ` : ''}BSE {company.scripCode} · {company.industry || 'Hospital'}
        </div>
      </div>

      <div className="stat">
        <div className="label">Price</div>
        <div className={`value ${changeClass}`}>
          ₹{q?.price != null ? fmtIndianNumber(q.price, { maximumFractionDigits: 2 }) : '—'}
          {q?.changePct != null && (
            <span className={`delta ${changeClass}`}>{fmtDelta(q.changePct)}</span>
          )}
        </div>
      </div>

      <div className="stat">
        <div className="label">Market cap</div>
        <div className="value">
          {q?.marketCapCr != null ? `₹${fmtIndianNumber(q.marketCapCr)} Cr` : '—'}
        </div>
      </div>

      <div className="stat">
        <div className="label">Coverage</div>
        <div className="value" style={{ fontSize: 14 }}>
          {cov?.extractedDocs ?? 0} docs · {cov?.quartersWithData ?? 0} quarters
        </div>
      </div>

      <div className="stat">
        <div className="label">Range</div>
        <div className="value" style={{ fontSize: 14 }}>
          {cov?.quarterRange || '—'}
        </div>
      </div>
    </div>
  );
}
