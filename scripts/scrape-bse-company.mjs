#!/usr/bin/env node
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchJSON, fmtDate, extractRows, loadCompanies, PDF_BASE } from './lib/bse.mjs';

const WINDOW_DAYS = Number(process.env.BSE_WINDOW_DAYS || 90);
const CHUNK_DAYS = Number(process.env.BSE_CHUNK_DAYS || 180);

const ANN_PAGE_URL = (scripCode, from, to, page) =>
  `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?pageno=${page}&strCat=-1&strPrevDate=${from}&strScrip=${scripCode}&strSearch=P&strToDate=${to}&strType=C`;

function chunkDateRange(startDate, endDate, chunkDays) {
  const chunks = [];
  let cursor = new Date(startDate.getTime());
  const oneDay = 86400000;
  while (cursor <= endDate) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + (chunkDays - 1) * oneDay, endDate.getTime()));
    chunks.push({ from: fmtDate(cursor), to: fmtDate(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + oneDay);
  }
  return chunks;
}

async function fetchAnnouncementsForChunk(scripCode, from, to) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = ANN_PAGE_URL(scripCode, from, to, page);
    const payload = await fetchJSON(url);
    const pageRows = extractRows(payload);
    rows.push(...pageRows);
    const reported = Number(pageRows[0]?.TotalPageCnt);
    if (Number.isFinite(reported) && reported > 0) totalPages = reported;
    page++;
    if (page > 50) break;
  } while (page <= totalPages);
  return { rows, pages: page - 1 };
}

async function fetchAnnouncementsWindow(scripCode, startDate, endDate) {
  const chunks = chunkDateRange(startDate, endDate, CHUNK_DAYS);
  const allRows = [];
  let totalPages = 0;
  const firstChunk = chunks[0];
  const firstUrl = ANN_PAGE_URL(scripCode, firstChunk.from, firstChunk.to, 1);
  for (const { from, to } of chunks) {
    const { rows, pages } = await fetchAnnouncementsForChunk(scripCode, from, to);
    allRows.push(...rows);
    totalPages += pages;
  }
  const byId = new Map();
  for (const r of allRows) {
    const id = r.NEWSID ?? `${r.SCRIP_CD}-${r.DT_TM}-${r.HEADLINE}`;
    if (!byId.has(id)) byId.set(id, r);
  }
  return { rows: [...byId.values()], url: firstUrl, pages: totalPages, chunks: chunks.length };
}

function urlOnlyEndpoints(scripCode, from, to) {
  return {
    corpActions: {
      tag: 'confirmed',
      url: `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Fdate=${from}&TDate=${to}&Purposecode=&ddlcategorys=E&ddlindustrys=&scripcode=${scripCode}&segment=0&strSearch=S`,
    },
    boardMeetings: {
      tag: 'confirmed',
      url: `https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?fromdate=${from}&todate=${to}&scripcode=${scripCode}`,
    },
    annualReports: {
      tag: 'confirmed',
      url: `https://api.bseindia.com/BseIndiaAPI/api/AnnualReport/w?scripcode=${scripCode}`,
    },
  };
}

function enrichAnnouncements(rows) {
  return rows.map((r) => {
    const att = r.ATTACHMENTNAME || r.AttachmentName;
    return att ? { ...r, PDF_URL: PDF_BASE + att } : r;
  });
}

async function loadExisting(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function mergeAnnouncementRows(existingRows, freshRows) {
  const byId = new Map();
  for (const r of existingRows || []) {
    const id = r.NEWSID ?? `${r.SCRIP_CD}-${r.DT_TM}-${r.HEADLINE}`;
    byId.set(id, r);
  }
  for (const r of freshRows) {
    const id = r.NEWSID ?? `${r.SCRIP_CD}-${r.DT_TM}-${r.HEADLINE}`;
    byId.set(id, r); // fresh wins
  }
  const out = [...byId.values()];
  out.sort((a, b) => String(b.DT_TM || '').localeCompare(String(a.DT_TM || '')));
  return out;
}

async function scrapeCompany({ scripCode, slug, shortName }) {
  const now = new Date();
  const startDate = new Date(now.getTime() - WINDOW_DAYS * 86400000);
  const FROM = fmtDate(startDate);
  const TO = fmtDate(now);
  const path = `data/bse-${slug}.json`;
  const existing = await loadExisting(path);

  const out = {
    scripCode,
    slug,
    name: shortName,
    fetchedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: WINDOW_DAYS, chunkDays: CHUNK_DAYS },
    categories: {},
  };

  // Announcements — chunked window + paginated within each chunk + merged with existing
  console.error(`  announcements…`);
  try {
    const { rows: raw, url, pages, chunks } = await fetchAnnouncementsWindow(scripCode, startDate, now);
    const fresh = enrichAnnouncements(raw);
    const merged = mergeAnnouncementRows(existing?.categories?.announcements?.data, fresh);
    out.categories.announcements = {
      ok: true,
      url,
      count: merged.length,
      countFresh: fresh.length,
      chunks,
      pages,
      tag: 'confirmed',
      data: merged,
    };
    console.error(`    ok (${fresh.length} fresh / ${merged.length} total across ${chunks} chunk(s), ${pages} page(s))`);
  } catch (e) {
    const url = ANN_PAGE_URL(scripCode, FROM, TO, 1);
    const fallback = existing?.categories?.announcements?.data || [];
    out.categories.announcements = { ok: false, url, count: fallback.length, tag: 'confirmed', error: e.message, data: fallback };
    console.error(`    FAILED: ${e.message} (kept ${fallback.length} existing rows)`);
  }

  // Other categories — single call each; preserve existing on transient failure
  for (const [name, { url, tag }] of Object.entries(urlOnlyEndpoints(scripCode, FROM, TO))) {
    console.error(`  ${name}…`);
    try {
      const payload = await fetchJSON(url);
      const rows = extractRows(payload);
      out.categories[name] = { ok: true, url, count: rows.length, tag, data: rows };
      console.error(`    ok (${rows.length})`);
    } catch (e) {
      const fallback = existing?.categories?.[name]?.data || [];
      out.categories[name] = { ok: false, url, count: fallback.length, tag, error: e.message, data: fallback };
      console.error(`    FAILED: ${e.message} (kept ${fallback.length} existing rows)`);
    }
  }

  const ann = out.categories.announcements;
  if (ann?.data?.length) {
    const rows = ann.data.filter((r) =>
      /result/i.test(r.CATEGORYNAME || r.Categoryname || r.NEWSSUB || '')
    );
    out.categories.results = {
      ok: ann.ok,
      tag: 'derived',
      source: 'announcements',
      count: rows.length,
      data: rows,
    };
  } else {
    out.categories.results = {
      ok: false,
      tag: 'derived',
      source: 'announcements',
      count: 0,
      error: 'announcements unavailable',
      data: [],
    };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2));
  console.error(`  → ${path}`);
  return out;
}

async function run() {
  const args = process.argv.slice(2);
  let targets;

  if (args[0] === '--all') {
    targets = await loadCompanies();
  } else if (args.length >= 2) {
    targets = [{ scripCode: args[0], slug: args[1], shortName: args[1] }];
  } else {
    console.error('Usage:');
    console.error('  node scripts/scrape-bse-company.mjs --all');
    console.error('  node scripts/scrape-bse-company.mjs <scripCode> <slug>');
    process.exit(0);
  }

  console.error(`Scraping ${targets.length} compan${targets.length === 1 ? 'y' : 'ies'} (window ${WINDOW_DAYS}d)`);
  const summary = [];
  for (const c of targets) {
    console.error(`\n[${c.slug}] ${c.shortName || c.name || ''} — ${c.scripCode}`);
    try {
      const out = await scrapeCompany(c);
      const okCount = Object.values(out.categories).filter((v) => v.ok).length;
      summary.push({ slug: c.slug, ok: okCount, total: Object.keys(out.categories).length });
    } catch (e) {
      console.error(`  TOP-LEVEL FAILURE: ${e.message}`);
      summary.push({ slug: c.slug, ok: 0, total: 0, error: e.message });
    }
  }

  console.error('\n=== Summary ===');
  for (const s of summary) {
    console.error(`  ${s.slug.padEnd(22)} ${s.ok}/${s.total} categories ok${s.error ? ` (${s.error})` : ''}`);
  }
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
