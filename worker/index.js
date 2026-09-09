// Cloudflare Worker entry. Owns /api/* and passes everything else through to
// the static dashboard (the ASSETS binding, with SPA fallback). Fully additive:
// the dashboard is served exactly as before for every non-/api/ request.

import { handleApi } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (e) {
        return new Response(
          JSON.stringify({ ok: false, error: 'server_error', detail: String((e && e.message) || e) }),
          { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
      }
    }
    // Static assets (index.html, /assets/*, /sector.json, /digest-feed.json …).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
