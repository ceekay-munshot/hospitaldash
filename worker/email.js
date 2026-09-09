// Thin client for the shared Munshot email API. Reused across dashboards.
// If MUNS_TOKEN isn't set we skip sending entirely (no crash) so the feature
// degrades gracefully in un-configured environments.

const DEFAULT_ENDPOINT = 'https://devde.muns.io/email/send/raw';

export function emailConfigured(env) {
  return !!(env && env.MUNS_TOKEN);
}

// body per spec: { email: <recipient>, subject, html } — field is `email`
// (not `to`), content is `html`, and there is NO `from` field.
export async function sendEmail(env, { email, subject, html }) {
  if (!emailConfigured(env)) return { sent: false, reason: 'email_not_configured' };
  const endpoint = env.MUNS_EMAIL_ENDPOINT || DEFAULT_ENDPOINT;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.MUNS_TOKEN}`,
      },
      body: JSON.stringify({ email, subject, html }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { sent: false, reason: `http_${res.status}`, detail };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'fetch_failed', detail: String((e && e.message) || e) };
  }
}
