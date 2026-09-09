// KV-backed subscription store. All functions no-op gracefully when the
// DIGEST_KV binding is absent (KV not yet configured) so the dashboard and API
// degrade instead of crashing.

const SUB = (hash) => `sub:${hash}`;
const UNSUB = (token) => `unsub:${token}`;

export function hasKV(env) {
  return !!(env && env.DIGEST_KV);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

export async function sha256hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function getSubByHash(env, hash) {
  if (!hasKV(env)) return null;
  const raw = await env.DIGEST_KV.get(SUB(hash));
  return raw ? JSON.parse(raw) : null;
}

export async function getHashByToken(env, token) {
  if (!hasKV(env) || !token) return null;
  return env.DIGEST_KV.get(UNSUB(token));
}

export async function putSub(env, sub) {
  if (!hasKV(env)) return;
  await env.DIGEST_KV.put(SUB(sub.emailHash), JSON.stringify(sub));
  if (sub.unsubToken) await env.DIGEST_KV.put(UNSUB(sub.unsubToken), sub.emailHash);
}

export async function deleteSub(env, sub) {
  if (!hasKV(env) || !sub) return;
  await env.DIGEST_KV.delete(SUB(sub.emailHash));
  if (sub.unsubToken) await env.DIGEST_KV.delete(UNSUB(sub.unsubToken));
}

// Enumerate every subscription (small scale — one KV list + get per key).
export async function listSubs(env) {
  if (!hasKV(env)) return [];
  const subs = [];
  let cursor;
  do {
    const page = await env.DIGEST_KV.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const raw = await env.DIGEST_KV.get(k.name);
      if (raw) {
        try {
          subs.push(JSON.parse(raw));
        } catch {
          /* skip corrupt */
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs;
}

// Simple per-email hourly rate limit for send-now. Returns true if allowed.
export async function rateLimitOk(env, hash, limit = 3) {
  if (!hasKV(env)) return true; // no KV → can't track, allow
  const bucket = new Date().toISOString().slice(0, 13); // yyyy-mm-ddTHH (UTC hour)
  const key = `rl:${hash}:${bucket}`;
  const cur = parseInt((await env.DIGEST_KV.get(key)) || '0', 10);
  if (cur >= limit) return false;
  await env.DIGEST_KV.put(key, String(cur + 1), { expirationTtl: 3600 });
  return true;
}
