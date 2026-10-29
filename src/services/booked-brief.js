'use strict';

/**
 * The "Meeting booked" brief: one email per booked meeting, laid out like the sample Josh approved
 * (Oct 29): opener, When and where, Who they are, Their company, How they booked, Conversation so
 * far, Call notes, Suggested talking points, Watch-outs, Links. Pure rendering; the data comes from
 * booked-brief-data.js. A section with nothing to show is left out (a missing field is "not found").
 */

const { escapeHtml } = require('./client-notify-email');

const BOOKED_NOTES_LINE = 'If you have any notes, just hit reply all. Our operations team sees it.';
const NO_SUMMARY = 'Allo has not produced a summary for this call yet.';

const WRAP = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;';
const H = 'margin:22px 0 8px;font-size:15px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;';
const CARD = 'border:1px solid #e5e7eb;border-radius:6px;padding:10px 14px;background:#fff;margin:0 0 10px 0;';

function s(v, max = 4000) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function link(url) {
  const u = s(url, 500);
  return /^https?:\/\//i.test(u) ? `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>` : escapeHtml(u);
}

function rowsHtml(rows) {
  return rows.map(([k, v, opts]) => {
    const val = s(v);
    const cell = !val
      ? '<span style="color:#999;">not found</span>'
      : (opts && opts.url ? link(val) : escapeHtml(val)).replace(/\n/g, '<br>');
    return `<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:3px 0;">${cell}</td></tr>`;
  }).join('');
}

function bullets(items) {
  const list = (items || []).map((i) => s(i, 600)).filter(Boolean);
  return list.length ? `<ul style="margin:4px 0 0;padding-left:20px;">${list.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
}

function numbered(items) {
  const list = (items || []).map((i) => s(i, 600)).filter(Boolean);
  return list.length ? `<ol style="margin:4px 0 0;padding-left:20px;">${list.map((i) => `<li style="margin:0 0 4px;">${escapeHtml(i)}</li>`).join('')}</ol>` : '';
}

function section(title, inner) {
  return inner ? `<h3 style="${H}">${escapeHtml(title)}</h3>${inner}` : '';
}

function messageHtml(m) {
  const who = s(m.from, 120) || 'Message';
  const head = [s(m.when, 80), who].filter(Boolean).join(' · ');
  const tone = m.direction === 'in' ? 'border-left:3px solid #f59e0b;background:#fffbeb;' : 'border-left:3px solid #d1d5db;background:#f9fafb;';
  return `<div style="${tone}padding:8px 12px;margin:0 0 8px 0;border-radius:4px;"><div style="font-size:12px;color:#666;margin:0 0 4px 0;">${escapeHtml(head)}</div>` +
    `<div style="white-space:pre-wrap;">${escapeHtml(s(m.body, 3000))}</div></div>`;
}

/**
 * @param {object} b
 *  clientName, prospect{name,company,title,email,phone,linkedinUrl,location}, titleNote,
 *  when{label, where, bookedLabel}, company{website,whatTheyDo,size,notes[]},
 *  how{client,channel,campaign,hook,sender,timeline,category},
 *  thread[{when,from,direction:'in'|'out',body}], summary, highlights, callNotesLabel,
 *  talkingPoints[], watchOuts[], links[{label,url}], noSummaryText
 */
function buildBookedBrief(b) {
  const p = b.prospect || {};
  const person = s(p.name, 200);
  const company = s(p.company, 200);
  const name = person || company || 'Prospect';
  const clientName = s(b.clientName, 200);
  const subject = `Meeting booked: ${name}${clientName ? ` \u00b7 ${clientName}` : ''}`;
  const at = person && company ? ` at ${company}` : '';
  const whenLabel = s(b.when && b.when.label, 200);

  const openerText = whenLabel
    ? `FYI, ${name}${at} booked a meeting for ${whenLabel}.`
    : `FYI, ${name}${at} booked a meeting.`;
  const openerHtml = escapeHtml(openerText).replace(escapeHtml(name), `<strong>${escapeHtml(name)}</strong>`)
    .replace(escapeHtml(whenLabel), `<strong>${escapeHtml(whenLabel)}</strong>`);

  const whenRows = [
    ['When', whenLabel || s(b.when && b.when.fallback, 300)],
    ['Where', b.when && b.when.where],
    ['Booked', b.when && b.when.bookedLabel],
  ].filter(([, v]) => s(v));

  const who = [
    ['Name', p.name],
    ['Title', p.title],
    // LinkedIn and Location are shown only when found; nothing is printed for a miss.
    ...(s(p.linkedinUrl) ? [['LinkedIn', p.linkedinUrl, { url: true }]] : []),
    ['Email', p.email],
    ['Cell', p.phone],
    ...(s(p.location) ? [['Location', p.location]] : []),
    ...(s(b.titleNote) ? [['Note', b.titleNote]] : []),
  ];

  const c = b.company || {};
  const companyRows = [
    ['Company', p.company],
    ['Website', c.website, { url: true }],
    ['What they do', c.whatTheyDo],
    ['Size', c.size],
  ];
  const companyNotes = bullets(c.notes);

  const h = b.how || {};
  const howRows = [
    ['Client', h.client || clientName],
    ['Channel', h.channel],
    ['Campaign', h.campaign],
    ['Hook', h.hook],
    ['Sender', h.sender],
    ['Timeline', h.timeline],
    ['Reply category', h.category],
  ].filter(([, v]) => s(v));

  const thread = (b.thread || []).filter((m) => s(m.body));
  const threadHtml = thread.map(messageHtml).join('');

  const sum = s(b.summary, 6000);
  const hl = b.highlights || null;
  const hlSections = [];
  if (hl) {
    if (hl.painPoints && hl.painPoints.length) hlSections.push(['Pain points', hl.painPoints]);
    if (hl.currentSetup) hlSections.push(['Current setup', [hl.currentSetup]]);
    if (hl.objections && hl.objections.length) hlSections.push(['Objections', hl.objections]);
    if (hl.nextStep) hlSections.push(['Next step', [hl.nextStep]]);
  }
  const callNotesLabel = s(b.callNotesLabel);
  const hasCall = Boolean(sum || hlSections.length || b.isCall);
  const callHtml = hasCall
    ? (callNotesLabel ? `<div style="font-size:12px;color:#666;margin:0 0 6px 0;">${escapeHtml(callNotesLabel)}</div>` : '') +
      `<div style="${CARD}">` +
      (sum ? `<div style="white-space:pre-wrap;">${escapeHtml(sum)}</div>` : '') +
      hlSections.map(([label, items]) => `<div style="margin:${sum ? '12px' : '0'} 0 0 0;"><div style="font-weight:600;">${escapeHtml(label)}</div>${bullets(items)}</div>`).join('') +
      (!sum && !hlSections.length ? `<div>${escapeHtml(s(b.noSummaryText) || NO_SUMMARY)}</div>` : '') +
      '</div>'
    : '';

  const links = (b.links || []).filter((l) => s(l.url));
  const linksHtml = links.length
    ? `<ul style="margin:4px 0 0;padding-left:20px;">${links.map((l) => `<li>${escapeHtml(l.label)}: ${link(l.url)}</li>`).join('')}</ul>`
    : '';

  const htmlBody = `
<div style="${WRAP}">
  <p>${openerHtml}</p>
  <p>${escapeHtml(BOOKED_NOTES_LINE)}</p>
  ${section('When and where', whenRows.length ? `<table style="border-collapse:collapse;font-size:14px;">${rowsHtml(whenRows)}</table>` : '')}
  ${section('Who they are', `<table style="border-collapse:collapse;font-size:14px;">${rowsHtml(who)}</table>`)}
  ${section('Their company', `<table style="border-collapse:collapse;font-size:14px;">${rowsHtml(companyRows)}</table>${companyNotes}`)}
  ${section('How they booked', howRows.length ? `<table style="border-collapse:collapse;font-size:14px;">${rowsHtml(howRows)}</table>` : '')}
  ${section('Conversation so far', threadHtml)}
  ${section('Call notes', callHtml)}
  ${section('Suggested talking points', numbered(b.talkingPoints))}
  ${section('Watch-outs', bullets(b.watchOuts))}
  ${section('Links', linksHtml)}
  <p style="margin:24px 0 0;color:#666;font-size:12px;">Sent automatically by SalesGlider operations.</p>
</div>`.replace(/\n\s*\n/g, '\n').trim();

  const T = [];
  T.push(openerText, BOOKED_NOTES_LINE, '');
  if (whenRows.length) T.push('WHEN AND WHERE', ...whenRows.map(([k, v]) => `${k}: ${s(v)}`), '');
  T.push('WHO THEY ARE', ...who.map(([k, v]) => `${k}: ${s(v) || 'not found'}`), '');
  T.push('THEIR COMPANY', ...companyRows.map(([k, v]) => `${k}: ${s(v) || 'not found'}`));
  for (const n of (c.notes || [])) if (s(n)) T.push(`- ${s(n)}`);
  T.push('');
  if (howRows.length) T.push('HOW THEY BOOKED', ...howRows.map(([k, v]) => `${k}: ${s(v)}`), '');
  if (thread.length) {
    T.push('CONVERSATION SO FAR');
    for (const m of thread) T.push([s(m.when, 80), s(m.from, 120)].filter(Boolean).join(' - '), s(m.body, 3000), '');
  }
  if (hasCall) {
    T.push('CALL NOTES');
    if (callNotesLabel) T.push(callNotesLabel);
    if (sum) T.push(sum, '');
    for (const [label, items] of hlSections) T.push(`${label}:`, ...items.map((i) => `- ${s(i)}`), '');
    if (!sum && !hlSections.length) T.push(s(b.noSummaryText) || NO_SUMMARY, '');
  }
  const tp = (b.talkingPoints || []).map((x) => s(x, 600)).filter(Boolean);
  if (tp.length) T.push('SUGGESTED TALKING POINTS', ...tp.map((x, i) => `${i + 1}. ${x}`), '');
  const wo = (b.watchOuts || []).map((x) => s(x, 600)).filter(Boolean);
  if (wo.length) T.push('WATCH-OUTS', ...wo.map((x) => `- ${x}`), '');
  if (links.length) T.push('LINKS', ...links.map((l) => `${l.label}: ${s(l.url, 500)}`), '');
  T.push('Sent automatically by SalesGlider operations.');
  const textBody = T.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  return { subject, htmlBody, textBody };
}

module.exports = { buildBookedBrief, BOOKED_NOTES_LINE, NO_SUMMARY };
