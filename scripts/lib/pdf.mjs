import { BROWSER_HEADERS } from './bse.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PDF_HEADERS = {
  ...BROWSER_HEADERS,
  Accept: 'application/pdf,application/octet-stream,*/*',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
};

// Older PDFs may live at AttachHis; recent at AttachLive. Try both.
const PATH_VARIANTS = [
  '/xml-data/corpfiling/AttachLive/',
  '/xml-data/corpfiling/AttachHis/',
];

let cookieJar = '';
let sessionWarmedAt = 0;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

async function ensureSession() {
  if (cookieJar && Date.now() - sessionWarmedAt < SESSION_TTL_MS) return;
  try {
    const res = await fetch('https://www.bseindia.com/corporates/ann.html', {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      cookieJar = setCookie
        .split(/,(?=\s*\w+=)/)
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    }
    sessionWarmedAt = Date.now();
  } catch {
    // best-effort; continue without session
  }
}

function variantsFor(originalUrl) {
  const filename = originalUrl.split('/').pop();
  return PATH_VARIANTS.map((p) => `https://www.bseindia.com${p}${filename}`);
}

async function tryDownloadOnce(url, referer) {
  const headers = { ...PDF_HEADERS };
  if (cookieJar) headers.Cookie = cookieJar;
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers, redirect: 'follow' });
  return res;
}

export async function downloadPdf(originalUrl, { referer = 'https://www.bseindia.com/corporates/ann.html', maxAttemptsPerPath = 3 } = {}) {
  await ensureSession();
  const variants = variantsFor(originalUrl);
  let lastErr;
  const tried = [];

  for (const url of variants) {
    const pathLabel = url.split('/').slice(-2, -1)[0];
    for (let attempt = 1; attempt <= maxAttemptsPerPath; attempt++) {
      try {
        const res = await tryDownloadOnce(url, referer);

        // 404 = file isn't at this path → try next variant immediately
        if (res.status === 404) {
          lastErr = new Error(`HTTP 404 at ${pathLabel}`);
          tried.push(`${pathLabel}:404`);
          break;
        }
        // Transient → backoff + retry same path
        if (res.status === 403 || res.status === 429 || res.status === 503) {
          if (attempt < maxAttemptsPerPath) {
            const wait = 3000 * attempt;
            await sleep(wait);
            continue;
          }
          lastErr = new Error(`HTTP ${res.status} at ${pathLabel} (after ${attempt} attempts)`);
          tried.push(`${pathLabel}:${res.status}`);
          break;
        }
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} at ${pathLabel}`);
          tried.push(`${pathLabel}:${res.status}`);
          break;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200) {
          lastErr = new Error(`payload too small at ${pathLabel} (${buf.length} bytes)`);
          tried.push(`${pathLabel}:tiny`);
          break;
        }
        const sig = buf.subarray(0, 5).toString('ascii');
        if (sig !== '%PDF-') {
          const preview = buf.subarray(0, 80).toString('ascii').replace(/\s+/g, ' ').trim();
          lastErr = new Error(`not a PDF at ${pathLabel} (got: "${preview.slice(0, 60)}…")`);
          tried.push(`${pathLabel}:html`);
          break;
        }
        return { buf, sourcePath: pathLabel };
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttemptsPerPath) await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(`${lastErr?.message || 'pdf download failed'} [tried: ${tried.join(', ')}]`);
}
