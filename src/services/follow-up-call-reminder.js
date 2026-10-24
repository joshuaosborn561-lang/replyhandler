/**
 * Follow-up cards show the lead's phone, plus a "call before sending"
 * reminder at most once per lead per Central day.
 *
 * Phone comes from the source reply (enrichment writes lead_phone there), or
 * from any other reply row for the same lead email/LinkedIn as a fallback.
 * The once-a-day gate lives in follow_up_call_reminders (created lazily).
 */
const REMINDER_TZ = 'America/Chicago';
let tableReady = null;

function ensureTable(db) {
  if (!tableReady) {
    tableReady = db.query(`
      CREATE TABLE IF NOT EXISTS follow_up_call_reminders (
        lead_key TEXT NOT NULL,
        day DATE NOT NULL,
        reply_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (lead_key, day)
      )`).catch((err) => { tableReady = null; throw err; });
  }
  return tableReady;
}

function centralDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function leadKey({ clientId, leadEmail, linkedinUrl, leadId }) {
  const who = String(leadEmail || '').trim().toLowerCase()
    || String(linkedinUrl || '').trim().toLowerCase()
    || String(leadId || '').trim();
  return who ? `${clientId || ''}|${who}` : '';
}

/** Best phone on file for this lead: source reply first, then any reply row for the lead. */
async function phoneForFollowUp(db, { clientId, sourceReplyId, leadEmail, linkedinUrl }) {
  if (sourceReplyId) {
    const { rows: [r] } = await db.query(
      `SELECT lead_phone, lead_phone_provider, lead_phone_alt FROM pending_replies WHERE id = $1`,
      [sourceReplyId],
    );
    if (r && (r.lead_phone || r.lead_phone_alt)) {
      return { phone: r.lead_phone || r.lead_phone_alt, provider: r.lead_phone_provider || null };
    }
  }
  const email = String(leadEmail || '').trim().toLowerCase();
  const li = String(linkedinUrl || '').trim();
  if (!email && !li) return { phone: null, provider: null };
  const { rows: [r] } = await db.query(
    `SELECT lead_phone, lead_phone_provider, lead_phone_alt FROM pending_replies
      WHERE client_id = $1
        AND (lead_phone IS NOT NULL OR lead_phone_alt IS NOT NULL)
        AND ((($2::text) <> '' AND lower(lead_email) = $2) OR (($3::text) <> '' AND linkedin_url = $3))
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [clientId, email, li],
  );
  if (!r) return { phone: null, provider: null };
  return { phone: r.lead_phone || r.lead_phone_alt, provider: r.lead_phone_provider || null };
}

/**
 * Claims today's reminder for this lead. True only for the first card of the
 * Central day; false afterwards or when there is no phone or no lead key.
 */
async function claimDailyCallReminder(db, { key, phone, replyId, now = new Date() }) {
  if (!key || !phone) return false;
  if (String(process.env.FOLLOW_UP_CALL_REMINDER || 'true').toLowerCase() === 'false') return false;
  await ensureTable(db);
  const { rows } = await db.query(
    `INSERT INTO follow_up_call_reminders (lead_key, day, reply_id)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (lead_key, day) DO NOTHING
     RETURNING lead_key`,
    [key, centralDay(now), replyId ? String(replyId) : null],
  );
  return rows.length > 0;
}

function reminderLine(phone) {
  return `📞 Call ${phone} before sending`;
}

function _resetForTests() { tableReady = null; }

module.exports = {
  phoneForFollowUp, claimDailyCallReminder, reminderLine, leadKey, centralDay, _resetForTests,
};
