// /api/* handlers for the digest feature. Everything here is additive; if KV or
// the email token is missing, endpoints return graceful JSON rather than error.

import {
  hasKV, normalizeEmail, isValidEmail, sha256hex, newToken,
  getSubByHash, getHashByToken, putSub, deleteSub, listSubs, rateLimitOk,
} from './store.js';
import { sendEmail, emailConfigured } from './email.js';
import { loadFeed, buildModel, cadenceLabelFor } from './feed.js';
import { normalizeSections, editionLabel } from '../shared/select.mjs';
import { renderDigestEmail } from '../shared/digest-email.mjs';
import {
  CATEGORIES, CATEGORY_KEYS, PALETTE, istDateStr, istWeekday, istTimeHHMM,
} from '../shared/categories.mjs';

// ── responses ─────────────────────────────────────────────────────────────
function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-digest-key',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors() },
  });
}
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── helpers ────────────────────────────────────────────────────────────────
function normalizeSectionsInput(sections) {
  if (!Array.isArray(sections)) return 'all';
  const keys = sections.filter((k) => CATEGORY_KEYS.includes(k));
  if (keys.length === 0 || keys.length === CATEGORY_KEYS.length) return 'all';
  return keys;
}
function validTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '') ? t : '08:00';
}

// ── GET /api/status — config + category source of truth for the UI ─────────
function status(env) {
  return json({
    ok: true,
    kvConfigured: hasKV(env),
    emailConfigured: emailConfigured(env),
    categories: CATEGORIES,
  });
}

// ── POST /api/subscribe ────────────────────────────────────────────────────
async function subscribe(request, env) {
  if (!hasKV(env)) {
    return json({ ok: false, error: 'subscriptions_unavailable', message: 'Subscriptions aren’t configured on the server yet.' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json({ ok: false, error: 'invalid_email', message: 'Please enter a valid email address.' }, 400);

  const cadence = body.cadence === 'daily' ? 'daily' : 'weekday';
  const time = validTime(body.time);
  const sections = normalizeSectionsInput(body.sections);
  const hash = await sha256hex(email);
  const existing = await getSubByHash(env, hash);
  const now = new Date().toISOString();

  const sub = {
    email,
    emailHash: hash,
    cadence,
    time,
    sections,
    // On re-subscribe keep the existing unsub token + last-sent date.
    unsubToken: (existing && existing.unsubToken) || newToken(),
    lastSentDate: (existing && existing.lastSentDate) || '',
    active: true,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
  await putSub(env, sub);

  const wanted = normalizeSections(sections);
  const edition = editionLabel(wanted);
  return json({
    ok: true,
    edition,
    cadence,
    time,
    resubscribed: !!existing,
    message: `Subscribed — you’ll get the ${edition} ${cadenceLabelFor(cadence)} at ${time} IST.`,
  });
}

// ── GET /api/unsubscribe?token= ────────────────────────────────────────────
async function unsubscribe(url, env) {
  const token = url.searchParams.get('token') || '';
  let email = '';
  if (hasKV(env) && token) {
    const hash = await getHashByToken(env, token);
    if (hash) {
      const sub = await getSubByHash(env, hash);
      if (sub) {
        email = sub.email;
        await deleteSub(env, sub);
      }
    }
  }
  return html(unsubPage(email));
}

// ── POST /api/run-digests (locked behind x-digest-key) ─────────────────────
async function runDigests(request, env) {
  if (!env.DIGEST_KEY) return json({ ok: false, error: 'not_configured', message: 'DIGEST_KEY is not set.' }, 503);
  const key = request.headers.get('x-digest-key') || '';
  if (key !== env.DIGEST_KEY) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!hasKV(env)) return json({ ok: false, error: 'subscriptions_unavailable' }, 503);

  const origin = env.SITE_URL || new URL(request.url).origin;
  const feed = await loadFeed(env, origin);
  if (!feed) return json({ ok: false, error: 'feed_unavailable' }, 503);

  const sendEmpty = String(env.SEND_EMPTY || '').toLowerCase() === 'true';
  const todayIST = istDateStr();
  const wd = istWeekday();
  const nowHHMM = istTimeHHMM();

  const subs = await listSubs(env);
  const result = { ok: true, checked: subs.length, sent: 0, skipped: {}, errors: [], dataDate: feed.dataDate, at: new Date().toISOString() };
  const skip = (r) => { result.skipped[r] = (result.skipped[r] || 0) + 1; };

  for (const sub of subs) {
    if (sub.active === false) { skip('inactive'); continue; }
    if (sub.cadence !== 'daily' && (wd === 0 || wd === 6)) { skip('weekend'); continue; }
    if (nowHHMM < (sub.time || '08:00')) { skip('before_time'); continue; }
    if (sub.lastSentDate === todayIST) { skip('already_sent_today'); continue; }

    const { selection, model } = buildModel(feed, sub, env, origin);
    const empty = selection.total === 0;
    const stale = !!sub.lastSentDate && !!feed.dataDate && feed.dataDate <= sub.lastSentDate;
    if ((empty || stale) && !sendEmpty) { skip(empty ? 'nothing_selected' : 'nothing_new'); continue; }

    const { subject, html: body } = renderDigestEmail(model);
    const r = await sendEmail(env, { email: sub.email, subject, html: body });
    if (r.sent) {
      sub.lastSentDate = todayIST;
      sub.updatedAt = new Date().toISOString();
      await putSub(env, sub);
      result.sent++;
    } else if (r.reason === 'email_not_configured') {
      skip('email_not_configured'); // don't record lastSent — retry once configured
    } else {
      result.errors.push({ hash: sub.emailHash.slice(0, 8), reason: r.reason });
      skip('send_failed');
    }
  }
  return json(result);
}

// ── POST /api/send-now (rate-limited) ──────────────────────────────────────
async function sendNow(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json({ ok: false, error: 'invalid_email', message: 'Please enter a valid email address.' }, 400);

  const origin = env.SITE_URL || new URL(request.url).origin;
  const hash = await sha256hex(email);
  if (!(await rateLimitOk(env, hash))) {
    return json({ ok: false, error: 'rate_limited', message: 'That address has hit the hourly limit — try again later.' }, 429);
  }
  const feed = await loadFeed(env, origin);
  if (!feed) return json({ ok: false, error: 'feed_unavailable', message: 'The brief isn’t available right now.' }, 503);

  // Honour saved prefs if this address is already subscribed.
  const existing = hasKV(env) ? await getSubByHash(env, hash) : null;
  const pseudo = {
    email,
    emailHash: hash,
    sections: existing ? existing.sections : normalizeSectionsInput(body.sections),
    cadence: existing ? existing.cadence : (body.cadence === 'daily' ? 'daily' : 'weekday'),
    time: existing ? existing.time : validTime(body.time),
    unsubToken: existing ? existing.unsubToken : '',
  };
  const { model } = buildModel(feed, pseudo, env, origin);
  const { subject, html: emailHtml } = renderDigestEmail(model);
  const r = await sendEmail(env, { email, subject, html: emailHtml });

  if (r.sent) return json({ ok: true, sent: true, subject });
  if (r.reason === 'email_not_configured') {
    return json({ ok: true, sent: false, reason: 'email_not_configured', message: 'Email delivery isn’t configured on the server yet.' });
  }
  return json({ ok: false, sent: false, error: r.reason, message: 'Could not send right now — please try again later.' }, 502);
}

// ── unsubscribe confirmation page (on-brand, minimal) ──────────────────────
function unsubPage(email) {
  const who = email ? `<strong>${email.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong>` : 'this address';
  const msg = email
    ? `${who} has been removed. You won’t receive any more Munshot briefs.`
    : `This unsubscribe link is invalid or already used. If you still receive briefs, use the link in the latest email.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed · Munshot</title></head>
<body style="margin:0;background:${PALETTE.cream};font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:12vh auto;background:${PALETTE.paper};border:1px solid ${PALETTE.rule};padding:40px 36px;text-align:center;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:bold;letter-spacing:6px;color:${PALETTE.ink};text-indent:6px;">MUNSHOT</div>
    <div style="border-top:3px double ${PALETTE.ink};margin:12px 0 16px;font-size:0;line-height:0;">&nbsp;</div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:${PALETTE.ink};margin:0 0 10px;">You’re unsubscribed</h1>
    <p style="font-size:14px;line-height:1.6;color:${PALETTE.body};margin:0;">${msg}</p>
    <p style="font-size:12px;color:${PALETTE.meta};margin:22px 0 0;">Changed your mind? Re-subscribe any time from the dashboard.</p>
  </div>
</body></html>`;
}

// ── router ─────────────────────────────────────────────────────────────────
export async function handleApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  const p = url.pathname;
  if (p === '/api/status' && request.method === 'GET') return status(env);
  if (p === '/api/subscribe' && request.method === 'POST') return subscribe(request, env);
  if (p === '/api/unsubscribe' && request.method === 'GET') return unsubscribe(url, env);
  if (p === '/api/run-digests' && request.method === 'POST') return runDigests(request, env);
  if (p === '/api/send-now' && request.method === 'POST') return sendNow(request, env);
  return json({ ok: false, error: 'not_found' }, 404);
}
