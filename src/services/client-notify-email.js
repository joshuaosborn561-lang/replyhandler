/**
 * Build the primary-domain client notify email (HTML + text)
 * with enrichment + thread history + outbound reply copy.
 *
 * Thread section mirrors a normal inbox: each message is a card with
 * Subject / From / To / body — not vague "Us" / "Prospect" labels.
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
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
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
} = {}) {
  const rows = messageListFromThread(threadContext);
  const lead = String(leadName || 'Prospect').trim() || 'Prospect';
  const leadAddr = pickAddress(leadEmail);
  const steps = [];
  let lastOurFrom = '';
  let lastSubject = '';

  const sorted = [...rows].sort((a, b) => {
    const ta = String(a?.time || a?.sent_at || a?.created_at || '');
    const tb = String(b?.time || b?.sent_at || b?.created_at || '');
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
    const already = steps.some((s) => s.body === plain);
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
    if (plain) {
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
}) {
  const name = String(leadName || 'Prospect').trim() || 'Prospect';
  const steps = normalizeThreadSteps(threadContext, {
    inboundMessage,
    sentText,
    leadName: name,
    leadEmail: leadEmail || enrichment?.email || null,
  });
  const subject = `Prospect reply: ${name}${clientName ? ` · ${clientName}` : ''}`;

  const htmlBody = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>FYI — we just replied to <strong>${escapeHtml(name)}</strong>${campaignName ? ` (${escapeHtml(String(campaignName))})` : ''}.</p>
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
  formatWhen,
  statusLabel,
};
