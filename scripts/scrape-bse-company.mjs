#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchJSON, fmtDate, extractRows, loadCompanies, PDF_BASE } from './lib/bse.mjs';

const WINDOW_DAYS = Number(process.env.BSE_WINDOW_DAYS || 90);

function endpointsFor(scripCode, from, to) {
  return {
    announcements: {
      tag: 'confirmed',
      url: `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?pageno=1&strCat=-1&strPrevDate=${from}&strScrip=${scripCode}&strSearch=P&strToDate=${to}&strType=C`,
    },
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

async function scrapeCompany({ scripCode, slug, shortName }) {
  const now = new Date();
  const FROM = fmtDate(new Date(now.getTime() - WINDOW_DAYS * 86400000));
  const TO = fmtDate(now);
  const ENDPOINTS = endpointsFor(scripCode, FROM, TO);

  const out = {
    scripCode,
    slug,
    name: shortName,
    fetchedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: WINDOW_DAYS },
    categories: {},
  };

  for (const [name, { url, tag }] of Object.entries(ENDPOINTS)) {
    console.error(`  ${name}…`);
    try {
      const payload = await fetchJSON(url);
      let rows = extractRows(payload);
      if (name === 'announcements') rows = enrichAnnouncements(rows);
      out.categories[name] = { ok: true, url, count: rows.length, tag, data: rows };
      console.error(`    ok (${rows.length})`);
    } catch (e) {
      out.categories[name] = { ok: false, url, count: 0, tag, error: e.message, data: [] };
      console.error(`    FAILED: ${e.message}`);
    }
  }

  const ann = out.categories.announcements;
  if (ann?.ok) {
    const rows = ann.data.filter((r) =>
      /result/i.test(r.CATEGORYNAME || r.Categoryname || r.NEWSSUB || '')
    );
    out.categories.results = {
      ok: true,
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

  const path = `data/bse-${slug}.json`;
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
