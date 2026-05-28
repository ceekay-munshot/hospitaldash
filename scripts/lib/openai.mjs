// OpenAI client for PDF metric extraction.
//
// Strategy: pdf-parse extracts text from PDF, send text + structured-output
// prompt to gpt-4o-mini, get JSON back. Text-only is more reliable than
// fiddling with OpenAI's multimodal PDF input (which has format quirks
// across API versions). Loses chart/image-only data but quarterly KPIs
// in hospital decks are almost always present as text too.
//
// Cost reference (gpt-4o-mini, Jan 2026):
//   Input: $0.15 / 1M tokens
//   Output: $0.60 / 1M tokens
//   Typical deck: ~12K input tokens × $0.15/M + ~1.5K output × $0.60/M = ~$0.003 per PDF

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MAX_INPUT_CHARS = 90_000; // ~22K tokens — safely under 128K context with prompt overhead

export async function callOpenAIWithPdf({
  pdfBuffer,
  prompt,
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  temperature = 0.1,
  maxAttempts = 4,
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  // 1. Extract text from PDF
  let text = '';
  try {
    const parsed = await pdfParse(pdfBuffer);
    text = parsed.text || '';
  } catch (e) {
    throw new Error(`pdf-parse failed: ${e.message}`);
  }
  if (!text || text.length < 100) {
    throw new Error(`PDF text too short (${text.length} chars) — likely image-only PDF`);
  }

  // 2. Truncate if too long
  const truncated = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '\n\n[... content truncated, PDF was ' + text.length + ' chars total]'
    : text;

  // 3. Call OpenAI
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an equity research analyst specializing in the Indian hospital sector. You extract structured metrics from financial filings. Return ONLY valid JSON matching the schema described in the user message, no markdown wrapping.',
      },
      {
        role: 'user',
        content: `${prompt}\n\n=== EXTRACTED PDF TEXT ===\n${truncated}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature,
  };

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 503) {
        const respText = await res.text();
        // OpenAI also returns 429 for "insufficient_quota" — escalate that
        if (/insufficient_quota/i.test(respText)) {
          const err = new Error(`OPENAI_INSUFFICIENT_QUOTA: ${respText.slice(0, 200)}`);
          err.insufficientQuota = true;
          throw err;
        }
        const wait = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
        console.error(`    OpenAI HTTP ${res.status} — wait ${wait / 1000}s (${attempt}/${maxAttempts})`);
        if (attempt === maxAttempts) throw new Error(`OpenAI HTTP ${res.status}: ${respText.slice(0, 200)}`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const respText = await res.text();
        throw new Error(`OpenAI HTTP ${res.status}: ${respText.slice(0, 300)}`);
      }

      const json = await res.json();
      const respText = json.choices?.[0]?.message?.content;
      if (!respText) throw new Error('Empty response from OpenAI');

      let parsed;
      try {
        parsed = JSON.parse(respText);
      } catch (e) {
        const stripped = respText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        parsed = JSON.parse(stripped);
      }

      return {
        parsed,
        finishReason: json.choices?.[0]?.finish_reason || null,
        usage: json.usage || null,
        model: json.model || model,
      };
    } catch (e) {
      if (e.insufficientQuota) throw e;
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 4000 * attempt;
        console.error(`    OpenAI error: ${e.message.slice(0, 120)} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('OpenAI exhausted retries');
}
