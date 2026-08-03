// Claude (AWS Bedrock) client for PDF metric extraction.
//
// Parallel path to lib/openai.mjs — same strategy (pdf-parse extracts text,
// send text + structured-output prompt to the model, get JSON back), but
// calls Claude via the Bedrock Runtime Converse API instead of OpenAI's
// chat completions API. Selected by LLM_PROVIDER=claude (see extract-metrics.mjs).
// This whole file + the LLM_PROVIDER branch that calls it can be deleted
// without touching the OpenAI or Gemini paths.
//
// Auth: Bedrock "API key" bearer token (Authorization: Bearer <token>), NOT
// SigV4. Region + model id default below — verify these against the actual
// AWS account/region this repo's Bedrock access is provisioned in.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_BEDROCK_REGION = process.env.BEDROCK_REGION || 'us-east-1';
export const DEFAULT_BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const MAX_INPUT_CHARS = 350_000; // Claude's context window is much larger than gpt-4o-mini's

function endpointFor(region, modelId) {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

export async function callClaudeWithPdf({
  pdfBuffer,
  prompt,
  apiKey,
  region = DEFAULT_BEDROCK_REGION,
  model = DEFAULT_BEDROCK_MODEL_ID,
  temperature = 0.1,
  maxAttempts = 4,
}) {
  if (!apiKey) throw new Error('temp_claude_token / BEDROCK_API_KEY missing');

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

  // 3. Call Claude via Bedrock Converse API
  const body = {
    system: [
      {
        text: 'You are an equity research analyst specializing in the Indian hospital sector. You extract structured metrics from financial filings. Return ONLY valid JSON matching the schema described in the user message, no markdown wrapping, no prose before or after the JSON.',
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { text: `${prompt}\n\n=== EXTRACTED PDF TEXT ===\n${truncated}` },
        ],
      },
    ],
    inferenceConfig: { temperature, maxTokens: 4096 },
  };

  const endpoint = endpointFor(region, model);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 503) {
        const respText = await res.text();
        const wait = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
        console.error(`    Bedrock HTTP ${res.status} — wait ${wait / 1000}s (${attempt}/${maxAttempts})`);
        if (attempt === maxAttempts) throw new Error(`Bedrock HTTP ${res.status}: ${respText.slice(0, 200)}`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const respText = await res.text();
        // No model access / bad credentials — hard stop, not worth retrying
        if (res.status === 403 || /AccessDeniedException/i.test(respText)) {
          const err = new Error(`BEDROCK_ACCESS_DENIED: ${respText.slice(0, 200)}`);
          err.insufficientQuota = true;
          throw err;
        }
        throw new Error(`Bedrock HTTP ${res.status}: ${respText.slice(0, 300)}`);
      }

      const json = await res.json();
      const respText = json.output?.message?.content?.map((c) => c.text || '').join('') || '';
      if (!respText) throw new Error('Empty response from Claude');

      let parsed;
      try {
        parsed = JSON.parse(respText);
      } catch (e) {
        const stripped = respText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        parsed = JSON.parse(stripped);
      }

      return {
        parsed,
        finishReason: json.stopReason || null,
        usage: json.usage || null,
        model,
      };
    } catch (e) {
      if (e.insufficientQuota) throw e;
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = 4000 * attempt;
        console.error(`    Claude/Bedrock error: ${e.message.slice(0, 120)} — retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('Claude/Bedrock exhausted retries');
}
