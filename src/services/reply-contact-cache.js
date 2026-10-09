/**
 * Read-only identity cache before any paid waterfall call.
 *
 * Sources: pending_replies history, {tag}_wf_contacts, name_bank.
 * Never writes. Never selects or updates dl_status, sg_exclude, skip_*.
 * Callers must not log the returned row.
 */

const { supabaseRequest } = require('./reply-examples');
const { clientTagFor } = require('./prospect-enrich');

const FORBIDDEN_COLUMNS = Object.freeze(['dl_status', 'sg_exclude']);
const FORBIDDEN_COLUMN_PREFIX = 'skip_';

const PENDING_CACHE_SELECT = [
  'lead_email',
  'lead_phone',
  'lead_phone_alt',
  'lead_website',
  'linkedin_url',
];

const SUPABASE_CONTACT_SELECT = 'email,phone,cellphone,domain,website,linkedin_url';

function assertSafeSelect(columns) {
  for (const col of columns) {
    const name = String(col || '').toLowerCase();
    if (FORBIDDEN_COLUMNS.includes(name) || name.startsWith(FORBIDDEN_COLUMN_PREFIX)) {
      throw new Error(`reply-contact-cache refuses column ${col}`);
    }
  }
}

function normalizeLinkedin(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase();
}

function asHit({ email, phone, website, linkedinUrl, domain, source } = {}) {
  const workEmail = String(email || '').trim().toLowerCase() || null;
  const cell = String(phone || '').trim() || null;
  const site = String(website || '').trim() || null;
  const li = String(linkedinUrl || '').trim() || null;
  const host = String(domain || '').trim() || null;
  if (!workEmail && !cell && !site && !li && !host) return null;
  return {
    email: workEmail,
    phone: cell,
    website: site,
    linkedinUrl: li,
    domain: host,
    source: source || 'cache',
  };
}

async function lookupPendingRepliesCache(db, { linkedinUrl, excludeReplyId } = {}) {
  const li = String(linkedinUrl || '').trim();
  if (!li || !db) return null;
  assertSafeSelect(PENDING_CACHE_SELECT);
  const { rows } = await db.query(
    `SELECT lead_email, lead_phone, lead_phone_alt, lead_website, linkedin_url
       FROM pending_replies
      WHERE id IS DISTINCT FROM $2
        AND linkedin_url IS NOT NULL
        AND lower(regexp_replace(linkedin_url, '^https?://(www\\.)?', '', 'i'))
            = lower(regexp_replace($1, '^https?://(www\\.)?', '', 'i'))
        AND (
          lead_email IS NOT NULL
          OR lead_phone IS NOT NULL
          OR lead_website IS NOT NULL
        )
      ORDER BY phone_enriched_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [li, excludeReplyId || null]
  );
  const row = rows[0];
  if (!row) return null;
  return asHit({
    email: row.lead_email,
    phone: row.lead_phone,
    website: row.lead_website,
    linkedinUrl: row.linkedin_url || li,
    source: 'pending_replies',
  });
}

async function supabaseSelect(table, query) {
  try {
    const rows = await supabaseRequest(`/rest/v1/${table}?${query}`, { method: 'GET' });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const msg = String(err.message || err);
    if (/\b404\b/.test(msg) || /does not exist|PGRST/i.test(msg)) return [];
    console.warn('[ReplyCache] supabase read skipped', { table, err: 'lookup_failed' });
    return [];
  }
}

function rowToHit(row, source) {
  if (!row || typeof row !== 'object') return null;
  return asHit({
    email: row.email,
    phone: row.phone || row.cellphone,
    website: row.website,
    linkedinUrl: row.linkedin_url,
    domain: row.domain,
    source,
  });
}

async function lookupSupabaseContacts({ clientTag, linkedinUrl } = {}) {
  const li = String(linkedinUrl || '').trim();
  if (!li) return null;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const tag = clientTagFor(clientTag);
  const encoded = encodeURIComponent(li);
  const filter = `linkedin_url=eq.${encoded}&select=${SUPABASE_CONTACT_SELECT}&limit=1`;
  const tables = [`${tag}_wf_contacts`, `${tag}_contacts`, 'name_bank'];

  for (const table of tables) {
    const rows = await supabaseSelect(table, filter);
    const hit = rowToHit(rows[0], table);
    if (hit) return hit;
  }

  const normalized = normalizeLinkedin(li);
  if (normalized && normalized !== li.toLowerCase()) {
    const alt = `linkedin_url=ilike.*${encodeURIComponent(normalized)}*&select=${SUPABASE_CONTACT_SELECT}&limit=1`;
    for (const table of tables) {
      const rows = await supabaseSelect(table, alt);
      const hit = rowToHit(rows[0], table);
      if (hit) return hit;
    }
  }
  return null;
}

function mergeCacheHits(...hits) {
  const out = {
    email: null,
    phone: null,
    website: null,
    linkedinUrl: null,
    domain: null,
    sources: {},
  };
  for (const hit of hits) {
    if (!hit) continue;
    if (!out.email && hit.email) {
      out.email = hit.email;
      out.sources.email = hit.source;
    }
    if (!out.phone && hit.phone) {
      out.phone = hit.phone;
      out.sources.phone = hit.source;
    }
    if (!out.website && hit.website) {
      out.website = hit.website;
      out.sources.website = hit.source;
    }
    if (!out.linkedinUrl && hit.linkedinUrl) {
      out.linkedinUrl = hit.linkedinUrl;
      out.sources.linkedin = hit.source;
    }
    if (!out.domain && hit.domain) {
      out.domain = hit.domain;
      out.sources.domain = hit.source;
    }
  }
  return out;
}

async function lookupReplyIdentity(db, {
  linkedinUrl, excludeReplyId, clientTag,
} = {}) {
  const pending = await lookupPendingRepliesCache(db, { linkedinUrl, excludeReplyId });
  const remote = await lookupSupabaseContacts({ clientTag, linkedinUrl });
  return mergeCacheHits(pending, remote);
}

module.exports = {
  FORBIDDEN_COLUMNS,
  FORBIDDEN_COLUMN_PREFIX,
  PENDING_CACHE_SELECT,
  SUPABASE_CONTACT_SELECT,
  assertSafeSelect,
  lookupPendingRepliesCache,
  lookupSupabaseContacts,
  lookupReplyIdentity,
  mergeCacheHits,
  normalizeLinkedin,
};
