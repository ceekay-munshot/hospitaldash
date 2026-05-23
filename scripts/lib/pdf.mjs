import { BROWSER_HEADERS } from './bse.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PDF_HEADERS = {
  ...BROWSER_HEADERS,
  Accept: 'application/pdf,application/octet-stream,*/*',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
};

export async function downloadPdf(url, { maxAttempts = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: PDF_HEADERS });
      if ((res.status === 404 || res.status === 403 || res.status === 429 || res.status === 503) && attempt < maxAttempts) {
        const wait = 4000 * attempt;
        console.error(`    pdf HTTP ${res.status} — retry in ${wait}ms (${attempt}/${maxAttempts})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error(`payload too small (${buf.length} bytes)`);

      // Strict PDF signature check — prevents wasted Gemini calls on HTML error pages
      const sig = buf.subarray(0, 5).toString('ascii');
      if (sig !== '%PDF-') {
        const preview = buf.subarray(0, 80).toString('ascii').replace(/\s+/g, ' ').trim();
        throw new Error(`not a PDF (got: "${preview.slice(0, 60)}…")`);
      }
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 3000 * attempt;
        console.error(`    pdf fetch ${e.message} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('pdf download failed');
}
