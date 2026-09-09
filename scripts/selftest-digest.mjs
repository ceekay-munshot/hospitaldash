// Deterministic integration test for the digest Worker handlers. Runs the REAL
// worker/api.js against an in-memory KV, a mock ASSETS binding serving the built
// feed, and a mocked email endpoint. No network, no Cloudflare needed.
//
//   npm run build   # (once, to produce dashboard/dist/digest-feed.json)
//   node scripts/selftest-digest.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../worker/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = JSON.parse(await readFile(path.join(ROOT, 'dashboard/dist/digest-feed.json'), 'utf8'));

// ── mocks ──────────────────────────────────────────────────────────────────
class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '', cursor } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

const sent = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/email/send/raw')) {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response('{"ok":true}', { status: 200 });
  }
  return origFetch(url, init);
};

const env = {
  DIGEST_KV: new MockKV(),
  DIGEST_KEY: 'test-secret',
  MUNS_TOKEN: 'test-token',
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/digest-feed.json') return new Response(JSON.stringify(FEED), { status: 200 });
      return new Response('not found', { status: 404 });
    },
  },
};

async function call(method, pathname, { body, headers } = {}) {
  const url = `http://localhost${pathname}`;
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleApi(req, env, {}, new URL(url));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

// ── assertions ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra != null ? `→ ${JSON.stringify(extra)}` : ''); }
}

console.log('digest self-test');

// status
let r = await call('GET', '/api/status');
check('status ok + KV + email configured', r.json?.ok && r.json.kvConfigured && r.json.emailConfigured, r.json);
check('status returns 6 categories', r.json?.categories?.length === 6, r.json?.categories?.length);

// subscribe (time 00:00 so "now >= time" is always true; daily so no weekend skip)
r = await call('POST', '/api/subscribe', { body: { email: 'Reader@Fund.com', cadence: 'daily', time: '00:00', sections: [] } });
check('subscribe ok, Full Brief', r.json?.ok && r.json.edition === 'Full Brief', r.json);

const subKey = [...env.DIGEST_KV.m.keys()].find((k) => k.startsWith('sub:'));
const sub = JSON.parse(env.DIGEST_KV.m.get(subKey));
check('email stored lowercased', sub.email === 'reader@fund.com', sub.email);
check('unsub token minted', !!sub.unsubToken && sub.lastSentDate === '', sub);

// run-digests: wrong key
r = await call('POST', '/api/run-digests', { headers: { 'x-digest-key': 'nope' } });
check('run-digests rejects wrong key (401)', r.status === 401, r.status);

// run-digests: right key → sends once
r = await call('POST', '/api/run-digests', { headers: { 'x-digest-key': 'test-secret' } });
check('run-digests sent 1', r.json?.sent === 1, r.json);
check('one email captured', sent.length === 1, sent.length);
check('subject shape "Munshot · N updates — D Mon"', /^Munshot · \d+ updates? — \d+ \w{3}$/.test(sent[0]?.subject || ''), sent[0]?.subject);
check('email body has MUNSHOT masthead + unsubscribe', /MUNSHOT/.test(sent[0]?.html) && /unsubscribe\?token=/.test(sent[0]?.html), null);
check('recipient field is "email", no "from"', 'email' in sent[0] && !('from' in sent[0]), Object.keys(sent[0] || {}));

// idempotency: immediate re-run → nothing (already sent today)
r = await call('POST', '/api/run-digests', { headers: { 'x-digest-key': 'test-secret' } });
check('run-digests idempotent (sent 0, already_sent_today)', r.json?.sent === 0 && r.json.skipped?.already_sent_today === 1, r.json?.skipped);

// re-subscribe keeps token + lastSentDate
const tokenBefore = JSON.parse(env.DIGEST_KV.m.get(subKey)).unsubToken;
const lastBefore = JSON.parse(env.DIGEST_KV.m.get(subKey)).lastSentDate;
r = await call('POST', '/api/subscribe', { body: { email: 'reader@fund.com', cadence: 'weekday', time: '07:30', sections: ['market', 'results'] } });
const subAfter = JSON.parse(env.DIGEST_KV.m.get(subKey));
check('re-subscribe keeps unsubToken + lastSentDate', subAfter.unsubToken === tokenBefore && subAfter.lastSentDate === lastBefore, subAfter);
check('re-subscribe updates sections', Array.isArray(subAfter.sections) && subAfter.sections.length === 2, subAfter.sections);

// send-now rate limit: 3 ok, 4th blocked
sent.length = 0;
const codes = [];
for (let i = 0; i < 4; i++) {
  const rr = await call('POST', '/api/send-now', { body: { email: 'rl@fund.com' } });
  codes.push(rr.status);
}
check('send-now allows 3 then 429', codes.filter((c) => c === 200).length === 3 && codes[3] === 429, codes);
check('send-now delivered 3 emails', sent.length === 3, sent.length);

// unsubscribe removes the record
r = await call('GET', `/api/unsubscribe?token=${tokenBefore}`);
check('unsubscribe returns 200 html', r.status === 200 && /unsubscribed/i.test(r.text), r.status);
r = await call('POST', '/api/run-digests', { headers: { 'x-digest-key': 'test-secret' } });
check('after unsubscribe, checked count drops', r.json?.checked === 0, r.json?.checked);

// SEND_EMPTY / nothing-selected behaviour: subscribe with an impossible empty selection is coerced to "all",
// so instead simulate stale (lastSentDate ahead of dataDate)
env.DIGEST_KV.m.clear();
await call('POST', '/api/subscribe', { body: { email: 'stale@fund.com', cadence: 'daily', time: '00:00' } });
const sk = [...env.DIGEST_KV.m.keys()].find((k) => k.startsWith('sub:'));
const s2 = JSON.parse(env.DIGEST_KV.m.get(sk));
s2.lastSentDate = '2999-01-01'; // far future → dataDate <= lastSent → stale
env.DIGEST_KV.m.set(sk, JSON.stringify(s2));
sent.length = 0;
r = await call('POST', '/api/run-digests', { headers: { 'x-digest-key': 'test-secret' } });
check('stale sub skipped as nothing_new', r.json?.sent === 0 && (r.json.skipped?.nothing_new === 1 || r.json.skipped?.already_sent_today === 1), r.json?.skipped);

globalThis.fetch = origFetch;
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
