#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchJSON, loadCompanies } from './lib/bse.mjs';

const QUOTE_URL = (scripCode) =>
  `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${scripCode}&seriesid=`;

const todayISO = () => new Date().toISOString().slice(0, 10);

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractSnapshot(payload) {
  const c = payload?.CurrRate || payload?.Currrate || {};
  const h = payload?.Header || payload?.header || {};
  return {
    date: todayISO(),
    price: num(c.LTP ?? h.CurrRate ?? c.CurrRate),
    open: num(c.Open ?? h.Open),
    high: num(c.High ?? h.High),
    low: num(c.Low ?? h.Low),
    prevClose: num(c.PrevClose ?? h.PrevClose),
    change: num(c.Chg ?? c.Change),
    changePct: num(c.PChg ?? c.PerChange),
    volume: num(c.TotalTradedQuantity ?? h.TotalTradedQuantity),
    value: num(c.TotalTradedValue ?? h.TotalTradedValue),
    weekHigh52: num(h.WeekHighDt ?? h['52WeekHigh'] ?? h.WeekHigh52),
    weekLow52: num(h.WeekLowDt ?? h['52WeekLow'] ?? h.WeekLow52),
    marketCapFullCr: num(h.MktCapFull ?? h.MarketCap ?? c.MarketCap),
    marketCapFreeFloatCr: num(h.MktCapFreeFloat),
    faceValue: num(h.FaceValue ?? c.FaceValue),
    raw: payload,
  };
}

async function scrapeQuote(company) {
  const url = QUOTE_URL(company.scripCode);
  const path = `data/quotes/${company.slug}.json`;
  console.error(`  ${company.slug} (${company.scripCode})`);

  let payload;
  try {
    payload = await fetchJSON(url);
  } catch (e) {
    console.error(`    FAILED: ${e.message}`);
    return { slug: company.slug, ok: false, error: e.message };
  }

  const snap = extractSnapshot(payload);
  const { raw, ...snapClean } = snap;

  let existing = { slug: company.slug, scripCode: company.scripCode, snapshots: [] };
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(existing.snapshots)) existing.snapshots = [];
  } catch {
    // first run
  }

  const today = todayISO();
  existing.snapshots = existing.snapshots.filter((s) => s.date !== today);
  existing.snapshots.push(snapClean);
  existing.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  existing.lastFetchedAt = new Date().toISOString();
  existing.latestRaw = raw;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
  console.error(`    ok price=${snap.price} mcap=${snap.marketCapFullCr} (${existing.snapshots.length} snapshots)`);
  return { slug: company.slug, ok: true, price: snap.price };
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
