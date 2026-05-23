import { BROWSER_HEADERS } from './bse.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function downloadPdf(url, { maxAttempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error(`PDF too small (${buf.length} bytes) — likely an error page`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 2000 * attempt;
        console.error(`    pdf fetch ${e.message} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('pdf download failed');
}
