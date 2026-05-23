#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [scripCode, slug] = process.argv.slice(2);

if (!scripCode || !slug) {
  console.error('Usage: node scripts/scrape-bse-company.mjs <6-digit-scripCode> <slug>');
  process.exit(0);
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const PDF_BASE = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/';
const WINDOW_DAYS = 90;
const MAX_ATTEMPTS = 4;

const fmtDate = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${da}`;
};

const now = new Date();
const FROM = fmtDate(new Date(now.getTime() - WINDOW_DAYS * 86400000));
const TO = fmtDate(now);

const ENDPOINTS = {
  announcements: {
    tag: 'confirmed',
    url: `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?pageno=1&strCat=-1&strPrevDate=${FROM}&strScrip=${scripCode}&strSearch=P&strToDate=${TO}&strType=C`,
  },
  corpActions: {
    tag: 'confirmed',
    url: `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Fdate=${FROM}&TDate=${TO}&Purposecode=&ddlcategorys=E&ddlindustrys=&scripcode=${scripCode}&segment=0&strSearch=S`,
  },
  boardMeetings: {
    tag: 'confirmed',
    url: `https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?fromdate=${FROM}&todate=${TO}&scripcode=${scripCode}`,
  },
  annualReports: {
    tag: 'confirmed',
    url: `https://api.bseindia.com/BseIndiaAPI/api/AnnualReport/w?scripcode=${scripCode}`,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.status === 403 || res.status === 429) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.error(`  HTTP ${res.status} — retry in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const trimmed = text.trim();
      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        throw new Error('Received HTML instead of JSON — wrong endpoint path');
      }
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.error(`  ${e.message} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('exhausted retries');
}

function extractRows(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Table)) return payload.Table;
  if (Array.isArray(payload.data)) return payload.data;
  if (typeof payload === 'object') {
    for (const v of Object.values(payload)) if (Array.isArray(v)) return v;
  }
  return [];
}

function enrichAnnouncements(rows) {
  return rows.map((r) => {
    const att = r.ATTACHMENTNAME || r.AttachmentName;
    return att ? { ...r, PDF_URL: PDF_BASE + att } : r;
  });
}

async function run() {
  const out = {
    scripCode,
    slug,
    fetchedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: WINDOW_DAYS },
    categories: {},
  };

  for (const [name, { url, tag }] of Object.entries(ENDPOINTS)) {
    console.error(`Fetching ${name}…`);
    try {
      const payload = await fetchJSON(url);
      let rows = extractRows(payload);
      if (name === 'announcements') rows = enrichAnnouncements(rows);
      out.categories[name] = { ok: true, url, count: rows.length, tag, data: rows };
      console.error(`  ok (${rows.length} rows)`);
    } catch (e) {
      out.categories[name] = { ok: false, url, count: 0, tag, error: e.message, data: [] };
      console.error(`  FAILED: ${e.message}`);
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
    console.error(`Derived results: ${rows.length} rows`);
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
  console.error(`Wrote ${path}`);
}

run()
  .catch((e) => console.error('Top-level error:', e))
  .finally(() => process.exit(0));
