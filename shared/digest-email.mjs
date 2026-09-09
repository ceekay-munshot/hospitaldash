// The one, pure, dependency-free "Munshot newspaper" email renderer.
// Importable by the Cloudflare Worker AND scripts/preview-email.mjs.
// All style values are fixed per spec; only text + category colours vary.

import { PALETTE, STATUS, CATEGORY_BY_KEY, esc, formatDayMon } from './categories.mjs';

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Arial,Helvetica,sans-serif';

function dot(color, size = 9) {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${color};vertical-align:middle;margin-right:5px;"></span>`;
}
function square(color, size = 8) {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:2px;background:${color};vertical-align:middle;margin-right:6px;"></span>`;
}

function catLabel(key) {
  return (CATEGORY_BY_KEY[key] && CATEGORY_BY_KEY[key].label) || key;
}

// Front-page display headline: movers already read as "<Co> +x% to ₹y";
// filings read as "<Co> — <Title>".
function frontHeadline(item) {
  const co = esc(item.entityShort || item.entity || '');
  const h = esc(item.headline || '');
  return item.kind === 'mover' ? `${co} ${h}` : `${co} — ${h}`;
}

function frontItemHTML(item) {
  const color = item.color || PALETTE.ink;
  const href = item.url ? esc(item.url) : '';
  const headline = frontHeadline(item);
  const headlineHTML = href
    ? `<a href="${href}" style="font-family:${SERIF};font-size:23px;line-height:1.24;font-weight:bold;color:${PALETTE.ink};text-decoration:none;">${headline}</a>`
    : `<span style="font-family:${SERIF};font-size:23px;line-height:1.24;font-weight:bold;color:${PALETTE.ink};">${headline}</span>`;
  const open = href
    ? ` · <a href="${href}" style="color:${PALETTE.link};font-weight:bold;text-decoration:none;">Open &rarr;</a>`
    : '';
  return `
  <div style="padding:16px 0 14px;border-bottom:1px solid ${PALETTE.rule};">
    <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${color};font-weight:bold;">${esc(catLabel(item.category))}</div>
    <div style="margin:6px 0 0;">${headlineHTML}</div>
    <div style="font-family:${SERIF};font-size:15px;font-style:italic;color:${PALETTE.body};margin:6px 0 0;">${esc(item.summary || '')}</div>
    <div style="font-family:${SANS};font-size:11px;color:${PALETTE.meta};margin:8px 0 0;"><b>${esc(item.entity || '')}</b> · ${esc(item.source || 'BSE')} · ${esc(formatDayMon(item.date))}${open}</div>
  </div>`;
}

function rowHTML(item) {
  const color = item.color || PALETTE.ink;
  const href = item.url ? esc(item.url) : '';
  const h = esc(item.headline || '');
  const headlineHTML = href
    ? `<a href="${href}" style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${PALETTE.ink};text-decoration:none;">${h}</a>`
    : `<span style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${PALETTE.ink};">${h}</span>`;
  let statusBit = '';
  if (item.status && STATUS[item.status]) {
    statusBit = `${dot(STATUS[item.status].color, 8)}${esc(item.statusLabel || STATUS[item.status].label)} · `;
  }
  return `
    <div style="padding:11px 0;border-bottom:1px solid ${PALETTE.rule};">
      <div style="font-family:${SANS};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${PALETTE.meta};font-weight:bold;">${square(color)}${esc(item.entityShort || item.entity || '')}</div>
      <div style="margin:4px 0 0;">${headlineHTML}</div>
      <div style="font-family:${SANS};font-size:12px;color:${PALETTE.bodySoft};margin:3px 0 0;">${esc(item.summary || '')}</div>
      <div style="font-family:${SANS};font-size:11px;color:${PALETTE.meta};margin:5px 0 0;">${statusBit}${esc(item.source || 'BSE')} · ${esc(formatDayMon(item.date))}</div>
    </div>`;
}

function sectionHTML(section) {
  const chip = `<span style="display:inline-block;background:${section.color};color:#ffffff;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:4px 12px;">${esc(section.label)}</span>`;
  return `
  <div style="margin:18px 0 0;">
    ${chip}
    ${section.items.map(rowHTML).join('')}
  </div>`;
}

function bynumbersHTML(bn) {
  const cell = (color, inner) => `<span style="display:inline-block;margin-right:18px;white-space:nowrap;">${dot(color)}${inner}</span>`;
  return `
  <div style="font-family:${SANS};font-size:12px;color:${PALETTE.body};line-height:1.9;">
    ${cell(PALETTE.ink, `<b>${bn.total}</b> in today&rsquo;s brief`)}
    ${cell(STATUS.positive.color, `<b>${bn.positive}</b> gainers`)}
    ${cell(STATUS.negative.color, `<b>${bn.negative}</b> decliners`)}
    ${cell(bn.busiestColor, `busiest: <b>${esc(bn.busiestLabel)}</b>`)}
  </div>`;
}

function emptyHTML() {
  return `
  <div style="text-align:center;padding:34px 0 30px;">
    <div style="font-family:${SERIF};font-size:20px;font-style:italic;color:${PALETTE.body};">Nothing new today.</div>
    <div style="font-family:${SANS};font-size:12px;color:${PALETTE.meta};margin-top:8px;">We&rsquo;ll email you the moment the next filing or price move lands.</div>
  </div>`;
}

/**
 * Render the digest email.
 * model: {
 *   product, brandLogoUrl, tagline,
 *   dateFull, subjectDate, editionLabel, cadenceLabel, timeLabel, tz,
 *   byNumbers, frontPage, sections, total, unsubUrl, siteUrl
 * }
 * returns { subject, html, text }
 */
export function renderDigestEmail(model) {
  const {
    product = 'Dashboard',
    brandLogoUrl = '',
    tagline = '',
    dateFull = '',
    subjectDate = '',
    editionLabel = 'Full Brief',
    cadenceLabel = 'every day',
    timeLabel = '08:00',
    tz = 'IST',
    byNumbers = { total: 0, positive: 0, negative: 0, busiestLabel: '—', busiestColor: PALETTE.ink },
    frontPage = [],
    sections = [],
    total = 0,
    unsubUrl = '#',
    siteUrl = '#',
  } = model;

  const subject = `Munshot · ${total} ${total === 1 ? 'update' : 'updates'} — ${subjectDate}`;
  const hasContent = frontPage.length > 0 || sections.length > 0;

  const masthead = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="Munshot" height="34" style="height:34px;display:inline-block;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-family:${SERIF};font-size:34px;font-weight:bold;letter-spacing:7px;color:${PALETTE.ink};text-indent:7px;">MUNSHOT</div>`;

  const body = hasContent
    ? `${frontPage.map(frontItemHTML).join('')}${sections.map(sectionHTML).join('')}`
    : emptyHTML();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.cream};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PALETTE.cream};font-size:1px;line-height:1px;">${esc(subject)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PALETTE.cream};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:${PALETTE.paper};border:1px solid ${PALETTE.rule};">
      <tr><td style="padding:30px 34px 0;text-align:center;">
        ${masthead}
        <div style="border-top:3px double ${PALETTE.ink};margin:12px 0 7px;font-size:0;line-height:0;">&nbsp;</div>
        <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;color:${PALETTE.meta};text-transform:uppercase;">${esc(tagline)}</div>
        <div style="border-top:1px solid ${PALETTE.rule};border-bottom:1px solid ${PALETTE.rule};font-family:${SANS};font-size:11px;letter-spacing:1px;color:${PALETTE.meta};text-transform:uppercase;padding:7px 0;margin-top:12px;">${esc(dateFull)} · Edition: ${esc(editionLabel)}</div>
      </td></tr>
      <tr><td style="padding:14px 34px 2px;">
        ${bynumbersHTML(byNumbers)}
      </td></tr>
      <tr><td style="padding:2px 34px 22px;">
        ${body}
      </td></tr>
      <tr><td style="background:${PALETTE.ink};padding:22px 34px;">
        <div style="font-family:${SANS};font-size:12px;color:#d8d0be;">You&rsquo;re subscribed to <span style="color:#f2ead6;">${esc(editionLabel)}</span>, ${esc(cadenceLabel)} at <span style="color:#f2ead6;">${esc(timeLabel)} ${esc(tz)}</span>.</div>
        <div style="font-family:${SANS};font-size:12px;margin-top:8px;"><a href="${esc(unsubUrl)}" style="color:#e0b48c;text-decoration:underline;">Unsubscribe</a><span style="color:#6b6455;"> · </span><span style="color:#a89f8b;">Powered by </span><a href="https://muns.io" style="color:#e8dfca;letter-spacing:1px;text-decoration:none;">Munshot</a><span style="color:#a89f8b;"> · muns.io</span></div>
        <div style="font-family:${SANS};font-size:10px;color:#6b6455;margin-top:10px;">Automated market brief compiled from public BSE filings and price data. Informational only — not investment advice.</div>
      </td></tr>
    </table>
    <div style="font-family:${SANS};font-size:10px;color:#a49b88;padding-top:12px;">${esc(product)} by Munshot</div>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text: plainText(model, subject) };
}

// Minimal plaintext alternative (not required by spec, handy for deliverability).
function plainText(model, subject) {
  const lines = [subject, ''];
  for (const i of model.frontPage || []) lines.push(`• ${i.entityShort || ''} ${i.headline || ''} — ${i.summary || ''}`);
  for (const s of model.sections || []) {
    lines.push('', s.label.toUpperCase());
    for (const i of s.items) lines.push(`  - ${i.entityShort || ''}: ${i.headline || ''}`);
  }
  lines.push('', `Unsubscribe: ${model.unsubUrl || ''}`, 'Powered by Munshot · muns.io');
  return lines.join('\n');
}
