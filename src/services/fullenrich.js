/**
 * FullEnrich — last email-waterfall tier (work email).
 * POST https://app.fullenrich.com/api/v2/contact/enrich/bulk
 */

function apiKey() {
  return String(process.env.FULLENRICH_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workEmailFromContact(contact) {
  const info = (contact && (contact.contact_info || contact.contact)) || contact || {};
  const emails = info.work_emails || info.emails || [];
  if (contact && contact.email) return String(contact.email).trim().toLowerCase();
  for (const item of emails) {
    if (typeof item === 'string' && item.includes('@')) return item.trim().toLowerCase();
    if (item && typeof item === 'object') {
      const e = String(item.email || '').trim().toLowerCase();
      if (e) return e;
    }
  }
  const most = contact && (contact.most_probable_email || contact.work_email);
  return most ? String(most).trim().toLowerCase() : null;
}

async function findEmail({ firstName, lastName, domain, companyName } = {}) {
  if (!apiKey()) return { email: null, skipped: 'not_configured' };
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  const dom = String(domain || '').trim();
  const company = String(companyName || '').trim();
  if (!first || !last || (!dom && !company)) {
    return { email: null, skipped: 'no_identifier' };
  }

  const payload = {
    first_name: first,
    last_name: last,
    enrich_fields: ['contact.work_emails'],
    custom: { idx: '0' },
  };
  if (company) payload.company_name = company;
  if (dom) payload.domain = dom;

  const res = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ name: 'replyhandler enrich', data: [payload] }),
  });
  const text = await res.text();
  let accepted;
  try { accepted = JSON.parse(text); } catch { accepted = {}; }
  if (!res.ok) {
    throw new Error(`FullEnrich enrich/bulk failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const enrichmentId = accepted.enrichment_id
    || accepted.id
    || (accepted.data && accepted.data.enrichment_id);
  if (!enrichmentId) return { email: null, skipped: 'no_enrichment_id' };

  const deadline = Date.now() + 90 * 1000;
  while (Date.now() < deadline) {
    const poll = await fetch(
      `https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          Accept: 'application/json',
        },
      }
    );
    const bodyText = await poll.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = {}; }
    const status = String(body.status || body.enrichment_status || '').toUpperCase();
    let contacts = body.datas || body.data || body.contacts || body.results || [];
    if (contacts && typeof contacts === 'object' && !Array.isArray(contacts)) {
      contacts = contacts.contacts || contacts.results || [];
    }
    if (['FINISHED', 'DONE', 'COMPLETED', 'SUCCESS'].includes(status)) {
      const row = (contacts || []).find((c) => c && typeof c === 'object') || {};
      return { email: workEmailFromContact(row) };
    }
    if (['FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)) {
      return { email: null, skipped: 'failed' };
    }
    await sleep(2000);
  }
  return { email: null, skipped: 'timeout' };
}

module.exports = {
  isConfigured,
  findEmail,
};
