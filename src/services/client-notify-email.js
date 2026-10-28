/**
 * Build the primary-domain client notify email (HTML + text)
 * with enrichment + thread history + outbound reply copy.
 *
 * Thread section mirrors a normal inbox: each message is a card with
 * Subject / From / To / body — not vague "Us" / "Prospect" labels.
 */

const { FYI_NOTES_LINE } = require('../utils/fyi-notify');

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plainFromHtmlish(s) {
  return String(s || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/\r\n/g, '\n')
    // Outlook/VML leftover after tag strip: `P {margin-top:0;}` / `v\:* {behavior:...}`
    .replace(/(^|\n)\s*[A-Za-z.#@\\][^{}\n]{0,80}\{[^}]{0,300}\}/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sortTime(m) {
  const raw = m?.time || m?.sent_at || m?.received_at || m?.created_at || '';
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : raw.toISOString();
  }
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return String(raw || '');
}

function normBody(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Prefer live SmartLead history (has later sends + From/To) over the inbound snapshot. */
function pickRicherThreadContext(live, stored) {
  if (messageListFromThread(live).length > 0) return live;
  return stored || live || null;
}

function extraRowsFromMessages(extraMessages) {
  if (!Array.isArray(extraMessages)) return [];
  return extraMessages
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      type: m.type || m.direction || (m.role === 'them' ? 'REPLY' : 'SENT'),
      email_body: m.email_body || m.body || m.message || m.text || '',
      time: m.time || m.sent_at || m.updated_at || '',
      from: m.from || m.from_email || '',
      to: m.to || m.to_email || '',
      subject: m.subject || '',
    }));
}

function messageListFromThread(threadContext) {
  if (!threadContext) return [];
  let ctx = threadContext;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { return []; }
  }
  if (Array.isArray(ctx)) return ctx;
  if (Array.isArray(ctx.messages)) return ctx.messages;
  if (Array.isArray(ctx.history)) return ctx.history;
  return [];
}

function classifyDirection(m) {
  const type = String(m.type || m.direction || m.role || m.sender || '').toUpperCase();
  if (type === 'SENT' || type === 'OUTBOUND' || type === 'US' || type === 'ME' || type === 'USER') {
    return 'sent';
  }
  if (
    type === 'REPLY' || type === 'INBOUND' || type === 'PROSPECT'
    || type === 'LEAD' || type === 'CORRESPONDENT' || type === 'THEM'
  ) {
    return 'reply';
  }
  if (/prospect|lead|them/i.test(String(m.role || ''))) return 'reply';
  return null;
}

function pickAddress(...candidates) {
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s && s.includes('@')) return s;
  }
  return '';
}

function formatWhen(raw) {
  if (!raw) return '';
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function statusLabel(direction, when) {
  const t = when ? ` on ${when}` : '';
  if (direction === 'sent') return `Email sent${t}`;
  if (direction === 'reply') return `Replied${t}`;
  if (direction === 'just_sent') return `You replied${t}`;
  return when || '';
}

/**
 * Normalize SmartLead / HeyReach thread_context into email-card steps.
 */
function normalizeThreadSteps(threadContext, {
  inboundMessage,
  sentText,
  leadName,
  leadEmail,
  extraMessages,
} = {}) {
  const rows = [
    ...messageListFromThread(threadContext),
    ...extraRowsFromMessages(extraMessages),
  ];
  const lead = String(leadName || 'Prospect').trim() || 'Prospect';
  const leadAddr = pickAddress(leadEmail);
  const steps = [];
  let lastOurFrom = '';
  let lastSubject = '';

  const sorted = [...rows].sort((a, b) => {
    const ta = sortTime(a);
    const tb = sortTime(b);
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    return 0;
  });

  for (const m of sorted) {
    if (!m || typeof m !== 'object') continue;
    const direction = classifyDirection(m);
    if (!direction) continue;
    const body = plainFromHtmlish(
      m.email_body || m.message || m.body || m.text || m.content || ''
    );
    if (!body) continue;

    const from = pickAddress(m.from, m.from_email, m.fromEmail)
      || (direction === 'sent' ? lastOurFrom : leadAddr);
    const to = pickAddress(m.to, m.to_email, m.toEmail)
      || (direction === 'sent' ? leadAddr : lastOurFrom);
    const subject = String(m.subject || '').trim() || lastSubject || '';
    const time = m.time || m.sent_at || m.received_at || m.created_at || '';

    if (direction === 'sent' && from) lastOurFrom = from;
    if (subject) lastSubject = subject;

    const key = `${direction}|${normBody(body).slice(0, 200)}`;
    if (steps.some((s) => `${s.direction}|${normBody(s.body).slice(0, 200)}` === key)) {
      continue;
    }

    // Show lead name only when the From address is the known lead email.
    // Colleague replies (Ashton vs Shelby) keep their own address.
    let fromLine = from || (direction === 'sent' ? 'Us' : lead);
    if (
      direction === 'reply'
      && from
      && lead
      && leadAddr
      && from.toLowerCase() === leadAddr.toLowerCase()
    ) {
      fromLine = `${lead} ${from}`;
    }

    steps.push({
      direction,
      status: statusLabel(direction, formatWhen(time)),
      subject,
      from: fromLine,
      to: to || (direction === 'sent' ? leadAddr || lead : lastOurFrom || 'Us'),
      body,
      time: formatWhen(time),
    });
  }

  // Ensure latest inbound is visible even if history is thin.
  if (inboundMessage) {
    const plain = plainFromHtmlish(inboundMessage);
    const norm = plain.toLowerCase().replace(/\s+/g, ' ').trim();
    const already = steps.some((s) => {
      const body = String(s.body || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm || !body) return false;
      return body === norm || body.includes(norm) || norm.includes(body.slice(0, Math.min(80, body.length)));
    });
    if (plain && !already) {
      steps.push({
        direction: 'reply',
        status: statusLabel('reply', ''),
        subject: lastSubject ? `RE: ${lastSubject.replace(/^re:\s*/i, '')}` : '',
        from: leadAddr ? `${lead} ${leadAddr}` : lead,
        to: lastOurFrom || 'Us',
        body: plain,
        time: '',
      });
    }
  }

  if (sentText) {
    const plain = plainFromHtmlish(sentText);
    const norm = normBody(plain);
    const existing = [...steps].reverse().find((s) => (
      (s.direction === 'sent' || s.direction === 'just_sent')
      && norm
      && normBody(s.body) === norm
    ));
    if (existing) {
      existing.direction = 'just_sent';
      existing.status = statusLabel('just_sent', existing.time);
    } else if (plain) {
      const subj = lastSubject
        ? ( /^re:/i.test(lastSubject) ? lastSubject : `RE: ${lastSubject}` )
        : '';
      steps.push({
        direction: 'just_sent',
        status: statusLabel('just_sent', formatWhen(new Date())),
        subject: subj,
        from: lastOurFrom || 'Us',
        to: leadAddr || lead,
        body: plain,
        time: formatWhen(new Date()),
      });
    }
  }

  // Full thread, not a 12-step tail. Long sequences still pin the opener.
  const MAX = 40;
  if (steps.length <= MAX) return steps;
  const head = steps.slice(0, 2);
  const tail = steps.slice(-(MAX - 2));
  const seen = new Set();
  const merged = [];
  for (const s of [...head, ...tail]) {
    const key = `${s.direction}|${normBody(s.body).slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  return merged;
}

function labelRowsHtml(rows) {
  return rows
    .map(([label, val]) => {
      if (!val) {
        return `<tr><td style="padding:2px 12px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;color:#999;">not found</td></tr>`;
      }
      const isUrl = /^https?:\/\//i.test(val);
      const cell = isUrl
        ? `<a href="${escapeHtml(val)}">${escapeHtml(val)}</a>`
        : escapeHtml(val);
      return `<tr><td style="padding:2px 12px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;">${cell}</td></tr>`;
    })
    .join('');
}

function enrichLinesHtml(enrichment) {
  const e = enrichment || {};
  return labelRowsHtml([
    ['Email', e.email],
    ['Cell', e.phone],
    ['LinkedIn', e.linkedinUrl],
    ['Website', e.website],
  ]);
}

function enrichLinesText(enrichment) {
  const e = enrichment || {};
  return [
    `Email: ${e.email || 'not found'}`,
    `Cell: ${e.phone || 'not found'}`,
    `LinkedIn: ${e.linkedinUrl || 'not found'}`,
    `Website: ${e.website || 'not found'}`,
  ].join('\n');
}

function threadHtml(steps) {
  if (!steps.length) return '<p><em>No prior thread available.</em></p>';
  return steps.map((s) => {
    const subjectRow = s.subject
      ? `<div style="font-weight:600;margin:0 0 6px 0;">${escapeHtml(s.subject)}</div>`
      : '';
    return (
      `<div style="margin:0 0 16px 0;">` +
      `<div style="font-size:12px;color:#666;margin:0 0 6px 0;">${escapeHtml(s.status || '')}</div>` +
      `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;background:#fff;">` +
      subjectRow +
      `<div style="font-size:13px;color:#374151;margin:0 0 2px 0;">From: ${escapeHtml(s.from || '')}</div>` +
      `<div style="font-size:13px;color:#374151;margin:0 0 10px 0;">To: ${escapeHtml(s.to || '')}</div>` +
      `<div style="white-space:pre-wrap;line-height:1.45;color:#111;">${escapeHtml(s.body)}</div>` +
      `</div></div>`
    );
  }).join('');
}

function threadText(steps) {
  if (!steps.length) return '(No prior thread available.)';
  return steps.map((s) => {
    const lines = [
      s.status || '',
      s.subject ? `Subject: ${s.subject}` : null,
      `From: ${s.from || ''}`,
      `To: ${s.to || ''}`,
      '',
      s.body,
    ].filter((x) => x != null);
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

function buildClientNotifyEmail({
  leadName,
  leadEmail,
  clientName,
  campaignName,
  enrichment,
  threadContext,
  inboundMessage,
  sentText,
  extraMessages,
}) {
  const name = String(leadName || 'Prospect').trim() || 'Prospect';
  const steps = normalizeThreadSteps(threadContext, {
    inboundMessage,
    sentText,
    leadName: name,
    leadEmail: leadEmail || enrichment?.email || null,
    extraMessages,
  });
  const subject = `Prospect reply: ${name}${clientName ? ` · ${clientName}` : ''}`;

  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>FYI — we just replied to <strong>${escapeHtml(name)}</strong>${campaignName ? ` (${escapeHtml(String(campaignName))})` : ''}.</p>
  <p>${escapeHtml(FYI_NOTES_LINE)}</p>
  <h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>
  <table style="border-collapse:collapse;font-size:14px;">${enrichLinesHtml(enrichment)}</table>
  <h3 style="margin:22px 0 8px;font-size:14px;">Thread</h3>
  ${threadHtml(steps)}
</div>`.trim();

  const textBody = [
    `FYI — we just replied to ${name}${campaignName ? ` (${campaignName})` : ''}.`,
    FYI_NOTES_LINE,
    '',
    'Prospect',
    enrichLinesText(enrichment),
    '',
    'Thread',
    threadText(steps),
  ].join('\n');

  return { subject, htmlBody, textBody };
}

const BOOKED_NOTES_LINE =
  'If you have any notes before the meeting, just hit reply all. Our operations team sees it.';

function highlightSections(h) {
  if (!h) return [];
  const out = [];
  if (h.painPoints && h.painPoints.length) out.push({ label: 'Pain points', items: h.painPoints });
  if (h.currentSetup) out.push({ label: 'Current setup', items: [h.currentSetup] });
  if (h.objections && h.objections.length) out.push({ label: 'Objections', items: h.objections });
  if (h.nextStep) out.push({ label: 'Next step', items: [h.nextStep] });
  return out;
}

/**
 * Same layout as the prospect-reply notify email (FYI line, notes line, Prospect table, a card
 * for the body) for a meeting a caller booked on a cold call. The card carries Allo's short
 * summary plus, when available, structured highlights from the transcript.
 */
function buildBookedMeetingNotifyEmail({
  prospect,
  clientName,
  callAtLabel,
  summary,
  highlights,
  noSummaryText,
}) {
  const p = prospect || {};
  const person = String(p.name || '').trim();
  const company = String(p.company || '').trim();
  const name = person || company || 'Prospect';
  const subject = `Meeting booked: ${name}${clientName ? ` · ${clientName}` : ''}`;
  const sections = highlightSections(highlights);
  const short = String(summary || '').trim();
  const status = ['Booked on a cold call', callAtLabel].filter(Boolean).join(' · ');
  const rows = [
    ['Name', p.name],
    ['Company', p.company],
    ['Title', p.title],
    ['Email', p.email],
    ['Cell', p.phone],
    // LinkedIn is shown only when found; nothing is printed for a miss.
    ...(p.linkedinUrl ? [['LinkedIn', p.linkedinUrl]] : []),
  ];
  const withCompany = person && company ? ` at ${company}` : '';
  const openerText = `FYI, we just booked a meeting with ${name}${withCompany} through a cold call.`;
  const openerHtml = `FYI, we just booked a meeting with <strong>${escapeHtml(name)}</strong>${
    withCompany ? ` at <strong>${escapeHtml(company)}</strong>` : ''
  } through a cold call.`;

  const bodyHtml = [
    short ? `<div style="white-space:pre-wrap;line-height:1.45;color:#111;">${escapeHtml(short)}</div>` : '',
    ...sections.map((sec) => (
      `<div style="margin:${short ? '12px' : '0'} 0 0 0;"><div style="font-weight:600;margin:0 0 4px 0;">${escapeHtml(sec.label)}</div>` +
      `<ul style="margin:0;padding-left:18px;line-height:1.45;">${sec.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`
    )),
    !short && !sections.length ? `<div style="color:#111;">${escapeHtml(noSummaryText)}</div>` : '',
  ].join('');

  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>${openerHtml}</p>
  <p>${escapeHtml(BOOKED_NOTES_LINE)}</p>
  <h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>
  <table style="border-collapse:collapse;font-size:14px;">${labelRowsHtml(rows)}</table>
  <h3 style="margin:22px 0 8px;font-size:14px;">Call summary</h3>
  <div style="margin:0 0 16px 0;">
    <div style="font-size:12px;color:#666;margin:0 0 6px 0;">${escapeHtml(status)}</div>
    <div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;background:#fff;">${bodyHtml}</div>
  </div>
</div>`.trim();

  const textBody = [
    openerText,
    BOOKED_NOTES_LINE,
    '',
    'Prospect',
    ...rows.map(([k, v]) => `${k}: ${v || 'not found'}`),
    '',
    'Call summary',
    status,
    '',
    ...(short ? [short, ''] : []),
    ...sections.flatMap((sec) => [`${sec.label}:`, ...sec.items.map((i) => `- ${i}`), '']),
    ...(!short && !sections.length ? [noSummaryText] : []),
  ].join('\n').trimEnd();

  return { subject, htmlBody, textBody };
}

/**
 * Warm lead from a cold call (interested, or a callback with an agreed time). Same layout as the booked-meeting
 * email; the copy never says a meeting is booked.
 */
function buildWarmLeadNotifyEmail({ kind, prospect, clientName, callAtLabel, title, summary, agreedTime, noSummaryText }) {
  const p = prospect || {};
  const person = String(p.name || '').trim();
  const company = String(p.company || '').trim();
  const name = person || company || 'Prospect';
  const callback = kind === 'callback';
  const subject = `${callback ? 'Callback set' : 'Warm lead'}: ${name}${clientName ? ` \u00b7 ${clientName}` : ''}`;
  const withCompany = person && company ? ` at ${company}` : '';
  const status = [callback ? 'Callback agreed on a cold call' : 'Interested on a cold call', callAtLabel].filter(Boolean).join(' \u00b7 ');
  const openerText = callback
    ? `FYI, ${name}${withCompany} asked for a callback on a cold call${agreedTime ? `. ${agreedTime}` : ''}. No meeting is booked yet.`
    : `FYI, ${name}${withCompany} showed interest on a cold call. This is a warm lead, not a booked meeting; we are following up.`;
  const openerHtml = escapeHtml(openerText)
    .replace(escapeHtml(name), `<strong>${escapeHtml(name)}</strong>`);
  const rows = [
    ['Name', p.name], ['Company', p.company], ['Title', p.title], ['Email', p.email], ['Cell', p.phone],
    ...(p.linkedinUrl ? [['LinkedIn', p.linkedinUrl]] : []),
  ];
  const noteLine = 'If you have any notes, just hit reply all. Our operations team sees it.';
  const short = String(summary || '').trim();
  const head = String(title || '').trim();
  const bodyHtml = [
    head ? `<div style="font-weight:600;margin:0 0 6px 0;">${escapeHtml(head)}</div>` : '',
    callback && agreedTime ? `<div style="margin:0 0 8px 0;"><strong>Agreed callback:</strong> ${escapeHtml(agreedTime)}</div>` : '',
    short ? `<div style="white-space:pre-wrap;line-height:1.45;color:#111;">${escapeHtml(short)}</div>` : '',
    !short && !head ? `<div style="color:#111;">${escapeHtml(noSummaryText)}</div>` : '',
  ].join('');
  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>${openerHtml}</p>
  <p>${escapeHtml(noteLine)}</p>
  <h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>
  <table style="border-collapse:collapse;font-size:14px;">${labelRowsHtml(rows)}</table>
  <h3 style="margin:22px 0 8px;font-size:14px;">Call summary</h3>
  <div style="margin:0 0 16px 0;">
    <div style="font-size:12px;color:#666;margin:0 0 6px 0;">${escapeHtml(status)}</div>
    <div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;background:#fff;">${bodyHtml}</div>
  </div>
</div>`.trim();
  const textBody = [
    openerText, noteLine, '', 'Prospect',
    ...rows.map(([k, v]) => `${k}: ${v || 'not found'}`),
    '', 'Call summary', status, '',
    ...(head ? [head] : []),
    ...(callback && agreedTime ? [`Agreed callback: ${agreedTime}`] : []),
    ...(short ? [short] : []),
    ...(!short && !head ? [noSummaryText] : []),
  ].join('\n').trimEnd();
  return { subject, htmlBody, textBody };
}

/**
 * Inbound-only copy of the same inbox-thread email, used by campaign-mapped
 * forwards. No "we just replied" line and no enrichment spend.
 */
function buildInboundForwardEmail({
  leadName,
  leadEmail,
  campaignName,
  campaignId,
  threadContext,
  inboundMessage,
}) {
  const name = String(leadName || 'Prospect').trim() || 'Prospect';
  const campaign = String(campaignName || '').trim()
    || (campaignId != null && String(campaignId).trim() ? `Campaign ${String(campaignId).trim()}` : '');
  const steps = normalizeThreadSteps(threadContext, {
    inboundMessage,
    sentText: '',
    leadName: name,
    leadEmail: leadEmail || null,
  });
  const subject = `Inbound reply: ${name}${campaign ? ` · ${campaign}` : ''}`;

  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>A new reply came in${campaign ? ` on <strong>${escapeHtml(campaign)}</strong>` : ''}.</p>
  <h3 style="margin:22px 0 8px;font-size:14px;">Thread</h3>
  ${threadHtml(steps)}
  <p style="margin-top:24px;color:#888;font-size:12px;">Sent from SalesGlider primary domain · campaign inbound forward · do not reply-all unless you intend to loop Joshua.</p>
</div>`.trim();

  const textBody = [
    `A new reply came in${campaign ? ` on ${campaign}` : ''}.`,
    '',
    'Thread',
    threadText(steps),
  ].join('\n');

  return { subject, htmlBody, textBody };
}

module.exports = {
  buildClientNotifyEmail,
  buildBookedMeetingNotifyEmail,
  buildWarmLeadNotifyEmail,
  BOOKED_NOTES_LINE,
  buildInboundForwardEmail,
  normalizeThreadSteps,
  pickRicherThreadContext,
  messageListFromThread,
  escapeHtml,
  formatWhen,
  statusLabel,
  plainFromHtmlish,
};
