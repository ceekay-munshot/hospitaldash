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

export async function callGeminiWithPdf({
  pdfBuffer,
  prompt,
  apiKey,
  model = DEFAULT_MODEL,
  temperature = 0.1,
  maxAttempts = 4,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  if (pdfBuffer.length > 19 * 1024 * 1024) {
    throw new Error(`PDF too large for inline data (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB > 19MB cap)`);
  }

  const url = `${ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`;
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 503) {
        const text = await res.text();
        const kind = classifyQuotaError(text);

        // Daily quota → no point retrying; bail out fast so caller can stop the whole run
        if (kind === 'daily') {
          const err = new Error(`GEMINI_DAILY_QUOTA_EXCEEDED: ${text.slice(0, 200)}`);
          err.dailyQuotaExceeded = true;
          throw err;
        }

        // Rate limit / availability → bounded backoff (max 60s, not 480s like before)
        const wait = Math.min(60_000, 10_000 * 2 ** (attempt - 1));
        console.error(`    HTTP ${res.status} (${kind || 'transient'}) — wait ${wait / 1000}s (${attempt}/${maxAttempts})`);
        if (attempt === maxAttempts) throw new Error(`HTTP ${res.status} (exhausted): ${text.slice(0, 200)}`);
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
      };
    } catch (e) {
      if (e.dailyQuotaExceeded) throw e; // never retry on daily quota
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 4000 * attempt;
        console.error(`    gemini error: ${e.message} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('gemini exhausted retries');
}
