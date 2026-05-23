export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const PDF_BASE = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJSON(url, { maxAttempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.status === 403 || res.status === 429) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.error(`    HTTP ${res.status} — retry in ${wait}ms (${attempt}/${maxAttempts})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        throw new Error('Received HTML instead of JSON — wrong endpoint path');
      }
      return JSON.parse(trimmed);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.error(`    ${e.message} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('exhausted retries');
}

export function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${da}`;
}

export function extractRows(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Table)) return payload.Table;
  if (Array.isArray(payload.data)) return payload.data;
  if (typeof payload === 'object') {
    for (const v of Object.values(payload)) if (Array.isArray(v)) return v;
  }
  return [];
}

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, '..', '..', 'data', 'companies.json');

export async function loadCompanies({ activeOnly = true } = {}) {
  const raw = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  return activeOnly ? raw.companies.filter((c) => c.active !== false) : raw.companies;
}
