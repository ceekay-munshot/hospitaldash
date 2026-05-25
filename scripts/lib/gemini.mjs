const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Distinguish "daily quota exhausted" (hard stop) from "rate-limited" (retry-able)
function classifyQuotaError(bodyText) {
  if (!bodyText) return null;
  if (/quota.*per day|requests per day|daily limit|exceeded your current quota/i.test(bodyText)) {
    return 'daily';
  }
  if (/quota|rate limit|exceeded/i.test(bodyText)) {
    return 'rate';
  }
  return null;
}

// ── Key rotation ─────────────────────────────────────────────────────────
// GEMINI_API_KEY can be a single key OR comma-separated multiple keys.
// We rotate round-robin; when one returns "daily quota exhausted", we mark
// it dead for this run and move to the next. Only fail completely when ALL
// keys are exhausted.
export class KeyPool {
  constructor(rawKeys) {
    this.keys = String(rawKeys || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.dead = new Set();
    this.cursor = 0;
  }
  size() { return this.keys.length; }
  aliveCount() { return this.keys.length - this.dead.size; }
  nextKey() {
    if (this.aliveCount() === 0) return null;
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      if (!this.dead.has(idx)) {
        this.cursor = (idx + 1) % this.keys.length;
        return { key: this.keys[idx], index: idx };
      }
    }
    return null;
  }
  markDead(index) { this.dead.add(index); }
  // Mask a key for logging (show first 6 + last 4 chars)
  static mask(k) {
    if (!k) return '<empty>';
    if (k.length <= 12) return '***';
    return `${k.slice(0, 6)}…${k.slice(-4)}`;
  }
}

export async function callGeminiWithPdf({
  pdfBuffer,
  prompt,
  keyPool,        // KeyPool instance (preferred)
  apiKey,         // OR single key (back-compat)
  model = DEFAULT_MODEL,
  temperature = 0.1,
  maxAttempts = 4,
}) {
  // Back-compat: wrap single key into a temp pool
  const pool = keyPool || new KeyPool(apiKey);
  if (pool.size() === 0) throw new Error('GEMINI_API_KEY missing');
  if (pdfBuffer.length > 19 * 1024 * 1024) {
    throw new Error(`PDF too large for inline data (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB > 19MB cap)`);
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature,
    },
  };

  let lastErr;
  // Try across keys — each key gets maxAttempts retries; when a key reports
  // daily-quota, mark it dead and try the next key (no waste).
  while (pool.aliveCount() > 0) {
    const picked = pool.nextKey();
    if (!picked) break;
    const { key, index } = picked;
    const maskedKey = KeyPool.mask(key);

    let keyExhausted = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = `${ENDPOINT(model)}?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.status === 429 || res.status === 503) {
          const text = await res.text();
          const kind = classifyQuotaError(text);

          if (kind === 'daily') {
            console.error(`    key ${maskedKey} (#${index}) hit DAILY quota — marking dead, switching key`);
            pool.markDead(index);
            keyExhausted = true;
            break;
          }

          const wait = Math.min(60_000, 10_000 * 2 ** (attempt - 1));
          console.error(`    HTTP ${res.status} (${kind || 'transient'}) — wait ${wait / 1000}s (${attempt}/${maxAttempts})`);
          if (attempt === maxAttempts) throw new Error(`HTTP ${res.status} (exhausted retries): ${text.slice(0, 200)}`);
          await sleep(wait);
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }

        const json = await res.json();
        const candidate = json.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const text = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error(`Empty response (finishReason=${finishReason || 'unknown'})`);
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
          parsed = JSON.parse(stripped);
        }

        return {
          parsed,
          finishReason,
          usage: json.usageMetadata || null,
          model,
          keyIndex: index,
        };
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts) {
          const wait = 4000 * attempt;
          console.error(`    gemini error (key ${maskedKey}): ${e.message} — retry in ${wait}ms`);
          await sleep(wait);
        }
      }
    }

    // If we exited the attempt loop without returning, either the key was marked dead (try next)
    // or maxAttempts exhausted without success → also try the next key.
    if (!keyExhausted) {
      console.error(`    key ${maskedKey} (#${index}) failed all ${maxAttempts} attempts — trying next key`);
      pool.markDead(index);
    }
  }

  // All keys dead
  const err = new Error(
    `GEMINI_DAILY_QUOTA_EXCEEDED on all ${pool.size()} key(s). ` +
    (lastErr?.message ? `Last error: ${lastErr.message.slice(0, 200)}` : '')
  );
  err.dailyQuotaExceeded = true;
  throw err;
}
