// Runtime feed access for the Worker: read the deploy-time digest-feed.json
// (a static asset) and turn a subscription's selection into a render model.

import { selectDigest } from '../shared/select.mjs';
import { formatDateFull, formatDayMon, nowIST } from '../shared/categories.mjs';

export async function loadFeed(env, origin) {
  if (!env.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/digest-feed.json', origin)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function cadenceLabelFor(cadence) {
  return cadence === 'daily' ? 'every day' : 'every weekday';
}

// Build a complete render model for one subscriber against the current feed.
export function buildModel(feed, sub, env, origin) {
  const sel = selectDigest(feed, { sections: sub.sections, moverUrl: origin });
  const isDaily = sub.cadence === 'daily';
  return {
    selection: sel,
    model: {
      product: feed.product,
      brandLogoUrl: env.BRAND_LOGO_URL || '',
      tagline: `${feed.product} — ${isDaily ? 'Daily' : 'Weekday'} Brief`,
      dateFull: formatDateFull(nowIST()),
      subjectDate: formatDayMon(nowIST()),
      editionLabel: sel.editionLabel,
      cadenceLabel: cadenceLabelFor(sub.cadence),
      timeLabel: sub.time,
      tz: 'IST',
      byNumbers: sel.byNumbers,
      frontPage: sel.frontPage,
      sections: sel.sections,
      total: sel.total,
      unsubUrl: `${origin}/api/unsubscribe?token=${encodeURIComponent(sub.unsubToken || '')}`,
      siteUrl: origin,
    },
  };
}
