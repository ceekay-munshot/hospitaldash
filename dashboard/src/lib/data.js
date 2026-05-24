export async function loadSectorData() {
  const res = await fetch(import.meta.env.BASE_URL + 'sector.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load sector.json (HTTP ${res.status})`);
  return res.json();
}

// For one company, get an ordered (oldest → newest) array of quarter values for a single metric.
export function timeSeries(companyData, metricKey) {
  if (!companyData?.quarters) return [];
  const quarters = Object.keys(companyData.quarters)
    .sort((a, b) => compareQuarter(a, b));
  return quarters
    .map((fq) => ({
      fq,
      label: companyData.quarters[fq].label || fq,
      value: companyData.quarters[fq].metrics?.[metricKey] ?? null,
    }))
    .filter((p) => p.value != null);
}

export function compareQuarter(a, b) {
  const ma = /^FY(\d{2})-Q([1-4])$/.exec(a);
  const mb = /^FY(\d{2})-Q([1-4])$/.exec(b);
  if (!ma || !mb) return String(a).localeCompare(String(b));
  if (ma[1] !== mb[1]) return Number(ma[1]) - Number(mb[1]);
  return Number(ma[2]) - Number(mb[2]);
}
