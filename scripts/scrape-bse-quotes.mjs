#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchJSON, loadCompanies } from './lib/bse.mjs';

const HEADER_URL = (scripCode) =>
  `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${scripCode}&seriesid=`;
const COMP_HEADER_URL = (scripCode) =>
  `https://api.bseindia.com/BseIndiaAPI/api/ComHeader/w?quotetype=EQ&scripcode=${scripCode}&seriesid=`;
const STOCK_TRADING_URL = (scripCode) =>
  `https://api.bseindia.com/BseIndiaAPI/api/StockTrading/w?flag=&quotetype=EQ&scripcode=${scripCode}`;

const todayISO = () => new Date().toISOString().slice(0, 10);

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const UNIT_MULT = (label) => {
  if (!label) return 1;
  const u = String(label).toLowerCase();
  if (u.includes('cr')) return 1e7;       // 1 crore = 10,000,000
  if (u.includes('lakh') || u.includes('lac')) return 1e5;
  if (u.includes('thousand')) return 1e3;
  return 1;
};

const withUnit = (value, unitLabel) => {
  const n = num(value);
  return n == null ? null : n * UNIT_MULT(unitLabel);
};

function extractSnapshot({ header, compHeader, stockTrading }) {
  const c = header?.CurrRate || {};
  const h = header?.Header || {};
  const ch = compHeader || {};
  const st = stockTrading || {};

  return {
    date: todayISO(),
    price: num(c.LTP ?? h.LTP),
    open: num(h.Open),
    high: num(h.High),
    low: num(h.Low),
    prevClose: num(h.PrevClose),
    change: num(c.Chg),
    changePct: num(c.PcChg),
    volumeShares: withUnit(st.TTQ, st.TTQin),
    turnoverInr: withUnit(st.Turnover, st.Turnoverin),
    twoWeekAvgVolumeShares: withUnit(st.TwoWkAvgQty, st.TwoWkAvgQtyin),
    weightedAvgPrice: num(st.WAP),
    marketCapFullCr: num(st.MktCapFull),
    marketCapFreeFloatCr: num(st.MktCapFF),
    circuitLimits: st.CktLimit || null,
    faceValue: num(ch.FaceVal ?? h.FaceValue),
    isin: ch.ISIN || null,
    ticker: ch.SecurityId || null,
    industry: ch.Industry || null,
    industryGroup: ch.IGroup || null,
    industrySubgroup: ch.ISubGroup || null,
    sector: ch.Sector || null,
    bseGroup: ch.Group || null,
    bseIndex: ch.Index || null,
    settlementType: ch.SetlType || null,
    eps: num(ch.EPS),
    pe: num(ch.PE),
    pb: num(ch.PB),
    roe: num(ch.ROE),
    operatingMargin: num(ch.OPM),
    netMargin: num(ch.NPM),
  };
}

async function tryFetch(label, url) {
  try {
    return await fetchJSON(url);
  } catch (e) {
    console.error(`    ${label} failed (${e.message}) — continuing`);
    return null;
  }
}

async function scrapeQuote(company) {
  const path = `data/quotes/${company.slug}.json`;
  console.error(`  ${company.slug} (${company.scripCode})`);

  const header = await tryFetch('header', HEADER_URL(company.scripCode));
  if (!header) return { slug: company.slug, ok: false, error: 'header endpoint failed' };

  const compHeader = await tryFetch('compHeader', COMP_HEADER_URL(company.scripCode));
  const stockTrading = await tryFetch('stockTrading', STOCK_TRADING_URL(company.scripCode));

  const snap = extractSnapshot({ header, compHeader, stockTrading });

  let existing = { slug: company.slug, scripCode: company.scripCode, snapshots: [] };
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(existing.snapshots)) existing.snapshots = [];
  } catch {
    // first run
  }

  const today = todayISO();
  existing.snapshots = existing.snapshots.filter((s) => s.date !== today);
  existing.snapshots.push(snap);
  existing.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  existing.lastFetchedAt = new Date().toISOString();
  existing.latestRaw = { header, compHeader, stockTrading };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
  console.error(`    ok price=${snap.price} mcap=${snap.marketCapFullCr}Cr vol=${snap.volumeShares} (${existing.snapshots.length} snapshots)`);
  return { slug: company.slug, ok: true, price: snap.price, mcap: snap.marketCapFullCr };
}

async function run() {
  const args = process.argv.slice(2);
  let targets;
  if (args[0] === '--all') {
    targets = await loadCompanies();
  } else if (args.length >= 2) {
    targets = [{ scripCode: args[0], slug: args[1] }];
  } else {
    console.error('Usage:');
    console.error('  node scripts/scrape-bse-quotes.mjs --all');
    console.error('  node scripts/scrape-bse-quotes.mjs <scripCode> <slug>');
    process.exit(0);
  }

  console.error(`Quotes for ${targets.length} compan${targets.length === 1 ? 'y' : 'ies'}`);
  const summary = [];
  for (const c of targets) summary.push(await scrapeQuote(c));

  console.error('\n=== Quote summary ===');
  for (const s of summary) {
    console.error(`  ${s.slug.padEnd(22)} ${s.ok ? `price=${s.price}` : `FAILED ${s.error}`}`);
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
