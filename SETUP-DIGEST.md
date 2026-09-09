# Email digest — one-time setup

The scheduled "Munshot Brief" email feature is **additive and optional**. The
dashboard deploys and runs exactly as before until you complete the steps below;
the API endpoints just return a graceful "not configured yet" until then.

Do this **once** and it stays automated forever — every push to `main` redeploys
the site and Worker, and a GitHub Action fires the hourly digest run.

## What ships in the repo

| Piece | Path |
| --- | --- |
| Worker API (`/api/*`) | `worker/` (`index.js`, `api.js`, `store.js`, `email.js`, `feed.js`) |
| Pure email renderer (server + preview share it) | `shared/digest-email.mjs` |
| Feed builder + category/status mapping | `shared/build-feed.mjs`, `shared/categories.mjs`, `shared/select.mjs` |
| Feed generated at build time → static asset | `dashboard/dist/digest-feed.json` (via `dashboard/prepare.mjs`) |
| Subscribe UI (slide-in "Brief" panel) | `dashboard/src/components/BriefPanel.jsx` |
| Hourly trigger | `.github/workflows/digest-hourly.yml` (cron `5 * * * *`) |
| Local preview | `npm run preview-email` → `email-preview.html` |
| Integration self-test | `npm run digest:selftest` |

## Setup checklist

1. **Connect the repo to Cloudflare** (Workers & Pages → Create → Connect to Git →
   this repo). Cloudflare reads `wrangler.jsonc`, runs the build command, and
   **auto-deploys every push to `main`** — no deploy step, no deploy secrets in
   the repo.

2. **Create the KV namespace** and bind it. Either run:

   ```bash
   npx wrangler kv namespace create DIGEST_KV
   ```

   then in `wrangler.jsonc` uncomment the `kv_namespaces` block and paste the
   returned `id`:

   ```jsonc
   "kv_namespaces": [
     { "binding": "DIGEST_KV", "id": "<paste-the-id-here>" }
   ],
   ```

   (Or add the binding in the Cloudflare dashboard → your Worker → Settings →
   Bindings → KV namespace, binding name `DIGEST_KV`.)

3. **Set the Worker secrets** (Cloudflare dashboard → your Worker → Settings →
   Variables and Secrets, or via CLI):

   ```bash
   npx wrangler secret put MUNS_TOKEN     # Bearer token for the Munshot email API
   npx wrangler secret put DIGEST_KEY     # any long random string
   ```

4. **Add the matching GitHub secret + variable** (repo → Settings → Secrets and
   variables → Actions):
   - Secret **`DIGEST_KEY`** — the *same* value as the Worker secret above.
   - Variable **`SITE_URL`** — your deployed origin, e.g.
     `https://hospitaldash.<your-subdomain>.workers.dev` (or a custom domain).

5. **(Optional) plain vars** on the Worker:
   - `SITE_URL` — canonical origin for links (defaults to the request origin).
   - `BRAND_LOGO_URL` — masthead logo image (defaults to the `MUNSHOT` wordmark).
   - `SEND_EMPTY=true` — email even on days with nothing new (default: skip).

That's it. The "Brief" button on the dashboard now subscribes people; the hourly
Action emails everyone due (once per day per person, IST), and every email has a
one-click unsubscribe link.

## Verify

```bash
npm run digest:selftest      # 19 handler checks, no network
npm run preview-email        # writes email-preview.html to open in a browser
```

To smoke-test the deployed run endpoint manually:

```bash
curl -i -X POST "$SITE_URL/api/run-digests" -H "x-digest-key: $DIGEST_KEY" -d '{}'
```

## Notes

- **Nothing to deliver → no email.** A subscriber is skipped when their chosen
  sections yield no items, or when nothing is newer than their last email
  (unless `SEND_EMPTY=true`).
- **Idempotent.** The per-subscriber once-per-day IST guard means a late or
  double hourly run is harmless.
- **Graceful degradation.** No `DIGEST_KV` → subscribe/run return a friendly
  503; no `MUNS_TOKEN` → sending is skipped, everything else still works. The
  dashboard itself is never affected.
