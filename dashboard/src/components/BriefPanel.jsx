import { useEffect, useState } from 'react';

// Fallback categories if /api/status isn't reachable (e.g. static-only preview).
// Kept in sync with shared/categories.mjs.
const FALLBACK_CATEGORIES = [
  { key: 'market', label: 'Market', color: '#3b82f6' },
  { key: 'results', label: 'Results', color: '#10b981' },
  { key: 'investor', label: 'Investor', color: '#8b5cf6' },
  { key: 'board', label: 'Board & Actions', color: '#f59e0b' },
  { key: 'ratings', label: 'Ratings', color: '#14b8a6' },
  { key: 'press', label: 'Press', color: '#64748b' },
];

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function BriefPanel({ open, onClose }) {
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [available, setAvailable] = useState({ kv: true, email: true, checked: false });
  const [email, setEmail] = useState('');
  const [cadence, setCadence] = useState('weekday');
  const [time, setTime] = useState('08:00');
  const [selected, setSelected] = useState(() => new Set(FALLBACK_CATEGORIES.map((c) => c.key)));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null); // { kind: 'ok'|'err'|'info', text }

  // Load config + the authoritative category list when the panel opens.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    fetch('/api/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (Array.isArray(d.categories) && d.categories.length) {
          setCategories(d.categories);
          setSelected(new Set(d.categories.map((c) => c.key)));
        }
        setAvailable({ kv: !!d.kvConfigured, email: !!d.emailConfigured, checked: true });
      })
      .catch(() => {
        if (!cancelled) setAvailable((a) => ({ ...a, checked: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const toggle = (k) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const sectionsPayload = () => categories.map((c) => c.key).filter((k) => selected.has(k));

  async function post(url) {
    setBusy(url);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, cadence, time, sections: sectionsPayload() }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok !== false) {
        if (url.endsWith('send-now')) {
          setMsg(d.sent ? { kind: 'ok', text: `Sent — check ${email}.` } : { kind: 'info', text: d.message || 'Nothing to send right now.' });
        } else {
          setMsg({ kind: 'ok', text: d.message || 'Subscribed.' });
        }
      } else {
        setMsg({ kind: 'err', text: d.message || 'Something went wrong.' });
      }
    } catch {
      setMsg({ kind: 'err', text: 'Network error — is the API deployed yet?' });
    } finally {
      setBusy('');
    }
  }

  const emailOk = emailRe.test(email);
  const noneSelected = sectionsPayload().length === 0;

  return (
    <>
      <div className={`brief-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`brief-panel ${open ? 'open' : ''}`} role="dialog" aria-label="Email brief subscription" aria-hidden={!open}>
        <header className="brief-head">
          <div>
            <div className="brief-kicker">MUNSHOT BRIEF</div>
            <h2>Get this dashboard by email</h2>
          </div>
          <button className="brief-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="brief-body">
          <p className="brief-lead">A newspaper-style digest of sector movers and fresh BSE filings — on your schedule.</p>

          <label className="brief-label" htmlFor="brief-email">Email address</label>
          <input id="brief-email" className="brief-input" type="email" placeholder="you@fund.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />

          <label className="brief-label">Frequency</label>
          <div className="brief-toggle">
            <button className={cadence === 'weekday' ? 'on' : ''} onClick={() => setCadence('weekday')} type="button">Every weekday</button>
            <button className={cadence === 'daily' ? 'on' : ''} onClick={() => setCadence('daily')} type="button">Every day</button>
          </div>

          <label className="brief-label" htmlFor="brief-time">Delivery time <span className="brief-tz">IST</span></label>
          <input id="brief-time" className="brief-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />

          <label className="brief-label">Sections to include</label>
          <div className="brief-cats">
            {categories.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`brief-cat ${selected.has(c.key) ? 'on' : ''}`}
                onClick={() => toggle(c.key)}
                style={{ '--cat': c.color }}
              >
                <span className="brief-cat-dot" style={{ background: c.color }} />
                {c.label}
              </button>
            ))}
          </div>

          {msg && <div className={`brief-msg ${msg.kind}`}>{msg.text}</div>}
          {available.checked && !available.kv && (
            <div className="brief-msg info">Subscriptions aren’t live yet — the server hasn’t finished setup.</div>
          )}

          <div className="brief-actions">
            <button className="brief-primary" type="button" disabled={!emailOk || noneSelected || !!busy} onClick={() => post('/api/subscribe')}>
              {busy.endsWith('subscribe') ? 'Subscribing…' : 'Subscribe'}
            </button>
            <button className="brief-secondary" type="button" disabled={!emailOk || !!busy} onClick={() => post('/api/send-now')}>
              {busy.endsWith('send-now') ? 'Sending…' : 'Email me this now'}
            </button>
          </div>
          <p className="brief-fine">One-click unsubscribe in every email. No account, no spam.</p>
        </div>
      </aside>
    </>
  );
}
