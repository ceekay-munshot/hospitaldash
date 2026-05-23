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

function deepFind(obj, predicate, depth = 4) {
  if (!obj || depth < 0) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const found = deepFind(v, predicate, depth - 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (predicate(k, v)) return v;
      const found = deepFind(v, predicate, depth - 1);
      if (found != null) return found;
    }
  }
  return null;
}

const findByKey = (obj, ...names) => {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return deepFind(obj, (k) => set.has(String(k).toLowerCase()));
};

function extractSnapshot({ header, compHeader, stockTrading }) {
  const c = header?.CurrRate || {};
  const h = header?.Header || {};
  const merged = { header, compHeader, stockTrading };

  return {
    date: todayISO(),
    price: num(c.LTP ?? h.LTP),
    open: num(h.Open),
    high: num(h.High),
    low: num(h.Low),
    prevClose: num(h.PrevClose),
    change: num(c.Chg),
    changePct: num(c.PcChg),
    volume: num(findByKey(merged, 'TotalTradedQuantity', 'TotalQuantityTraded', 'TotalTrdQty', 'Volume', 'VOLUME')),
    value: num(findByKey(merged, 'TotalTradedValue', 'TotalTradeValue', 'Value', 'VALUE')),
    weekHigh52: num(findByKey(merged, '52WeekHigh', 'WeekHigh52', 'WeekH', 'YearlyHigh')),
    weekLow52: num(findByKey(merged, '52WeekLow', 'WeekLow52', 'WeekL', 'YearlyLow')),
    marketCapFullCr: num(findByKey(merged, 'MktCapFull', 'MarketCapFull', 'MarketCap', 'MCap', 'FFMCap')),
    marketCapFreeFloatCr: num(findByKey(merged, 'MktCapFreeFloat', 'FreeFloatMcap', 'FFMcap')),
    faceValue: num(findByKey(merged, 'FaceValue', 'FACEVAL')),
    deliveryPct: num(findByKey(merged, 'DeliveryPercentage', 'DelPercent', 'DELPER')),
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
  console.error(`    ok price=${snap.price} mcap=${snap.marketCapFullCr} vol=${snap.volume} (${existing.snapshots.length} snapshots)`);
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
