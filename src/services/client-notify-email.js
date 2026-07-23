/**
 * Build the primary-domain client notify email (HTML + text)
 * with enrichment + thread history + outbound reply copy.
 */

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plainFromHtmlish(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .trim();
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

function normalizeThreadSteps(threadContext, { inboundMessage, sentText, leadName } = {}) {
  const rows = messageListFromThread(threadContext);
  const steps = [];
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || m.role || m.sender || '').toUpperCase();
    const body = plainFromHtmlish(
      m.message || m.body || m.text || m.email_body || m.content || ''
    );
    if (!body) continue;
    let who = 'Message';
    if (type === 'SENT' || type === 'OUTBOUND' || type === 'US' || type === 'ME' || type === 'USER') {
      who = 'Us';
    } else if (
      type === 'REPLY' || type === 'INBOUND' || type === 'PROSPECT'
      || type === 'LEAD' || type === 'CORRESPONDENT'
    ) {
      who = leadName || 'Prospect';
    } else if (/prospect|lead/i.test(String(m.role || ''))) {
      who = leadName || 'Prospect';
    }
    steps.push({ who, body, time: m.time || m.sent_at || m.created_at || '' });
  }

  // Ensure latest inbound + our just-sent reply are visible even if history is thin.
  if (inboundMessage) {
    const plain = plainFromHtmlish(inboundMessage);
    const already = steps.some((s) => s.body === plain);
    if (plain && !already) steps.push({ who: leadName || 'Prospect', body: plain, time: '' });
  }
  if (sentText) {
    const plain = plainFromHtmlish(sentText);
    steps.push({ who: 'Us (just sent)', body: plain, time: '' });
  }
  return steps.slice(-12);
}

function enrichLinesHtml(enrichment) {
  const e = enrichment || {};
  const rows = [
    ['Email', e.email],
    ['Cell', e.phone],
    ['LinkedIn', e.linkedinUrl],
    ['Website', e.website],
  ];
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
  return steps.map((s) => (
    `<div style="margin:0 0 14px 0;">` +
    `<div style="font-size:12px;color:#666;margin-bottom:4px;"><strong>${escapeHtml(s.who)}</strong>` +
    `${s.time ? ` · ${escapeHtml(String(s.time))}` : ''}</div>` +
    `<div style="white-space:pre-wrap;line-height:1.4;">${escapeHtml(s.body)}</div>` +
    `</div>`
  )).join('');
}

function threadText(steps) {
  if (!steps.length) return '(No prior thread available.)';
  return steps.map((s) => `[${s.who}${s.time ? ` · ${s.time}` : ''}]\n${s.body}`).join('\n\n---\n\n');
}

function buildClientNotifyEmail({
  leadName,
  clientName,
  campaignName,
  enrichment,
  threadContext,
  inboundMessage,
  sentText,
}) {
  const name = String(leadName || 'Prospect').trim() || 'Prospect';
  const steps = normalizeThreadSteps(threadContext, { inboundMessage, sentText, leadName: name });
  const subject = `Prospect reply: ${name}${clientName ? ` · ${clientName}` : ''}`;

  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>FYI — we just replied to <strong>${escapeHtml(name)}</strong>${campaignName ? ` (${escapeHtml(campaignName)})` : ''}.</p>
  <h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>
  <table style="border-collapse:collapse;font-size:14px;">${enrichLinesHtml(enrichment)}</table>
  <h3 style="margin:22px 0 8px;font-size:14px;">Thread</h3>
  ${threadHtml(steps)}
  <p style="margin-top:24px;color:#888;font-size:12px;">Sent from SalesGlider primary domain · do not reply-all to this notify unless you intend to loop Joshua.</p>
</div>`.trim();

  const textBody = [
    `FYI — we just replied to ${name}${campaignName ? ` (${campaignName})` : ''}.`,
    '',
    'Prospect',
    enrichLinesText(enrichment),
    '',
    'Thread',
    threadText(steps),
  ].join('\n');

  return { subject, htmlBody, textBody };
}

module.exports = {
  buildClientNotifyEmail,
  normalizeThreadSteps,
  escapeHtml,
};
