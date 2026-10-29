const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');
const {
  decodeHtmlEntities,
  foldDashAndQuotes,
  DASH_CODEPOINTS,
  SINGLE_QUOTE_CODEPOINTS,
  DOUBLE_QUOTE_CODEPOINTS,
  NAMED_HTML_ENTITIES,
} = require('../utils/html-entities');
const { canonicalInboundMessageId } = require('../utils/inbound-message-id');

/**
 * Strip embedded signature images / data-URIs before dedupe.
 *
 * SmartLead often re-encodes the same signature PNG on each history fetch, so
 * the base64 payload changes while the real reply text does not. Leaving it in
 * the dedupe key made each poll look like a brand-new inbound (Carter Howard
 * FOLLOW_UP loop, 2026-08-27).
 */
function stripEmbeddedBinaries(text) {
  return String(text || '')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ');
}

/**
 * Collapse every Unicode space (including NBSP U+00A0) to a single ASCII space.
 *
 * Critical: Postgres POSIX `\s` does NOT match NBSP, while JavaScript `\s`
 * does. LinkedIn/HeyReach bodies often contain NBSP (e.g. before a URL).
 * If SQL keeps the NBSP and JS turns it into a normal space, dedupe never
 * matches and the poller re-posts the same card every cycle.
 */
/**
 * Quote markers and SmartLead bracket expansions that differ between the
 * HTML reply webhook and the plain-text category webhook / poller.
 * Henry Witt, Oct 26 2026: the two bodies diverged at character 97
 * (`> ` on the signature and `[mwitt@hmwitt.com]`), inside the 120-char prefix.
 */
function stripInboundRenderArtifacts(text) {
  return String(text || '')
    .replace(/<mailto:[^>]*>/gi, ' ')
    .replace(/\[(?:link|email)\]/gi, ' ')
    .replace(/\[[^\]\s]*@[^\]\s]*\]/gi, ' ')
    .replace(/^[ \t]*>+[ \t]?/gm, '')
    .replace(/[ \t]+>[ \t]+/g, ' ');
}

/**
 * One normalizer for storage, dedupe, and preferFullerInbound.
 *
 * `forStorage` keeps case, newlines, and the decoded dash so the card still
 * reads naturally. Comparison folds dashes and quotes, strips the same
 * artifacts, and collapses whitespace. Both modes share this function, so
 * the card, the stored row, and the dedupe key cannot drift apart again.
 */
function normalizeInboundText(text, opts = {}) {
  const decoded = decodeHtmlEntities(stripEmbeddedBinaries(text));
  const stripped = stripInboundRenderArtifacts(decoded);
  if (opts && opts.forStorage) {
    return stripped
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return foldDashAndQuotes(stripped)
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** What we persist. Decoded and artifact-stripped. Dashes stay as typed. */
function decodeInboundForStorage(text) {
  return normalizeInboundText(text, { forStorage: true });
}

/**
 * Dedupe key for a reply body.
 *
 * The webhook and the poller render the same reply differently — one keeps the
 * quoted "From:" header, the other expands links and image alt-text — so the
 * two texts agree for a long opening run and then diverge in the tail. Exact
 * comparison misses that; a leading slice does not. Measured on a real pair:
 * identical for 165 chars, total lengths 182 vs 350.
 *
 * Shorter than the window means the whole message is compared, so short
 * replies still need to match exactly.
 */
const PREFIX_LEN = 120;

function inboundPrefix(text) {
  return normalizeInboundText(text).slice(0, PREFIX_LEN);
}

/**
 * Every codepoint normalizeInboundText's regex strips, mirrored for SQL.
 * Postgres POSIX `\s` matches none of these, so each needs its own `replace()`
 * before the `\s+` collapse — chr(160) and chr(8239) alone (the old list)
 * missed zero-width space (8203) and friends. A prospect's signature line with
 * invisible characters like "Pete Langlois ​ ​ ​ ​" then
 * normalized differently on the JS side vs the stored-column SQL side, so
 * dedupe never matched and the poller re-posted the same reply every cycle
 * (2026-08-05, Pete Langlois/TechEvolution — 170 duplicate cards over ~4h).
 */
const UNICODE_SPACE_CODEPOINTS = [
  160,   // NBSP
  5760,  // OGHAM SPACE MARK
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, // EN QUAD .. ZERO WIDTH SPACE
  8239,  // NARROW NBSP
  8287,  // MEDIUM MATHEMATICAL SPACE
  12288, // IDEOGRAPHIC SPACE
  65279, // ZERO WIDTH NO-BREAK SPACE / BOM
];

function stripUnicodeSpacesSql(column) {
  return UNICODE_SPACE_CODEPOINTS.reduce(
    (sql, code) => `replace(${sql}, chr(${code}), ' ')`,
    column
  );
}

const STORED_STRIP_BINARIES_SQL = (
  `regexp_replace(` +
  `regexp_replace(inbound_message, 'data:image/[^;]+;base64,[A-Za-z0-9+/=]+', ' ', 'gi'), ` +
  `'<img[^>]*>', ' ', 'gi')`
);

/**
 * Entity spellings and raw characters that must fold the same way
 * normalizeInboundText does. Incoming text is decoded in JS; stored rows
 * may still contain `&#8211;` until migration 040 rewrites them, and a
 * decoded en dash must still match an ASCII hyphen.
 *
 * One alternation per folded result, not a replace per codepoint, so the
 * dedupe query stays cheap on leads that already have hundreds of rows.
 */
function entityAlternation(codes, namesByCode) {
  const parts = [];
  for (const code of codes) {
    parts.push(`&#0*${code};`);
    parts.push(`&#x0*${code.toString(16)};`);
    for (const name of namesByCode[code] || []) parts.push(`&${name};`);
  }
  return parts.join('|');
}

function regexpReplaceLiteral(expr, pattern, sqlLiteral) {
  return `regexp_replace(${expr}, '${pattern}', ${sqlLiteral}, 'gi')`;
}

function foldCodepointsSql(expr, codes, sqlLiteral) {
  return codes.reduce(
    (sql, code) => `replace(${sql}, chr(${code}), ${sqlLiteral})`,
    expr
  );
}

const NAMED_CODEPOINTS = {};
for (const [name, ch] of Object.entries(NAMED_HTML_ENTITIES)) {
  const code = ch.codePointAt(0);
  if (!NAMED_CODEPOINTS[code]) NAMED_CODEPOINTS[code] = [];
  NAMED_CODEPOINTS[code].push(name);
}

const APOSTROPHE_ENTITY_CODES = [0x27, ...SINGLE_QUOTE_CODEPOINTS];
const QUOTE_ENTITY_CODES = [0x22, ...DOUBLE_QUOTE_CODEPOINTS];

function applyEntityFoldSql(expr) {
  let sql = expr;
  // Unwrap &amp; first so `&amp;ndash;` / `&amp;#8211;` become a real entity
  // before the dash pass. Twice covers `&amp;amp;`.
  const amp = entityAlternation([0x26], NAMED_CODEPOINTS);
  sql = regexpReplaceLiteral(sql, amp, "'&'");
  sql = regexpReplaceLiteral(sql, amp, "'&'");
  sql = regexpReplaceLiteral(sql, entityAlternation(DASH_CODEPOINTS, NAMED_CODEPOINTS), "'-'");
  sql = regexpReplaceLiteral(sql, entityAlternation(APOSTROPHE_ENTITY_CODES, NAMED_CODEPOINTS), "''''");
  sql = regexpReplaceLiteral(sql, entityAlternation(QUOTE_ENTITY_CODES, NAMED_CODEPOINTS), `'\"'`);
  const spaceEntityCodes = [0xA0, 0x2002, 0x2003, 0x2009];
  sql = regexpReplaceLiteral(sql, entityAlternation(spaceEntityCodes, NAMED_CODEPOINTS), "' '");
  for (const [code] of Object.entries(NAMED_CODEPOINTS)) {
    const n = Number(code);
    if (spaceEntityCodes.includes(n)) continue;
    if (DASH_CODEPOINTS.includes(n)) continue;
    if (APOSTROPHE_ENTITY_CODES.includes(n)) continue;
    if (QUOTE_ENTITY_CODES.includes(n)) continue;
    if (n === 0x26) continue;
    sql = regexpReplaceLiteral(sql, entityAlternation([n], NAMED_CODEPOINTS), `chr(${n})`);
  }
  sql = foldCodepointsSql(sql, DASH_CODEPOINTS, "'-'");
  sql = foldCodepointsSql(sql, SINGLE_QUOTE_CODEPOINTS, "''''");
  sql = foldCodepointsSql(sql, DOUBLE_QUOTE_CODEPOINTS, `'\"'`);
  return sql;
}

/**
 * Same artifact strip as stripInboundRenderArtifacts, after entity decode
 * so `&gt;` has already become `>`.
 */
function applyArtifactStripSql(expr) {
  let sql = expr;
  sql = `regexp_replace(${sql}, '<mailto:[^>]*>', ' ', 'gi')`;
  sql = `regexp_replace(${sql}, '\\[(link|email)\\]', ' ', 'gi')`;
  sql = `regexp_replace(${sql}, '\\[[^]]*@[^]]*\\]', ' ', 'gi')`;
  sql = `regexp_replace(${sql}, '(^|[[:space:]])>+[[:space:]]*', '\\1', 'g')`;
  return sql;
}

const STORED_NORM_SQL = (
  `lower(trim(both from regexp_replace(` +
  `${stripUnicodeSpacesSql(applyArtifactStripSql(applyEntityFoldSql(STORED_STRIP_BINARIES_SQL)))}, ` +
  `'\\s+', ' ', 'g')))`
);

/** SQL for the same key, applied to the stored column. */
const STORED_PREFIX_SQL = `left(${STORED_NORM_SQL}, ${PREFIX_LEN})`;

/**
 * Shortest text that can safely be called "the same reply". Below this, a
 * containment match would collapse genuinely different short replies.
 */
const MIN_CONTAINMENT_LEN = 40;

/**
 * SQL that matches a stored reply against one we are considering.
 *
 * Two ways the same reply can look different between the webhook and the
 * poller, and both must count as a duplicate:
 *   - divergent tails (signature, quoted headers) → compare leading slices
 *   - one rendering truncated earlier than the other → prefix containment
 *
 * Deliberately NOT time-bounded, and never keyed on SmartLead stats id or
 * campaign. The same text from the same person is always a duplicate.
 * Different text from the same person is always a new reply, however soon
 * it arrives. A stats-id window was tried and removed: a duplicate card is
 * preferable to swallowing a real response (Doug Baden, 2026-08-03; Josh,
 * 2026-10-22).
 *
 * $p = 120-char prefix, $f = full normalised text.
 */
function sameReplySql(prefixParam, fullParam) {
  return `(
    (${prefixParam}::text <> '' AND ${STORED_PREFIX_SQL} = ${prefixParam})
    OR (
      length(${fullParam}::text) >= ${MIN_CONTAINMENT_LEN}
      AND length(${STORED_NORM_SQL}) >= ${MIN_CONTAINMENT_LEN}
      AND (
        left(${STORED_NORM_SQL}, length(${fullParam}::text)) = ${fullParam}
        OR left(${fullParam}::text, length(${STORED_NORM_SQL})) = ${STORED_NORM_SQL}
      )
    )
  )`;
}

function samePersonSql(leadIdParam, leadEmailParam) {
  return `(
    (${leadIdParam}::text <> '' AND COALESCE(lead_id, '') = ${leadIdParam})
    OR (${leadEmailParam}::text <> '' AND lower(COALESCE(lead_email, '')) = ${leadEmailParam})
  )`;
}

/**
 * Any non-FOLLOW_UP row for this person + this inbound text.
 *
 * Do not require slack_message_ts. The webhook inserts first and posts Slack
 * second; if the poller only counted posted cards, it inserted a second row
 * during that window and we double-carded / double-sent (Casey Buckstaff,
 * 2026-10-05 — webhook card + "polling backstop" card 2 seconds later).
 */
const CAMPAIGN_DEDUPE_MIN_LEN = 40;
const INBOUND_ROW_COLUMNS = `id, status, inbound_message, inbound_message_id, classification, suppression_reason, slack_message_ts`;

/**
 * Text match is the fallback. A stored row that already has a different
 * Message-ID is a different email, even when the words are identical
 * ("Thanks" twice). A row with no id still matches on text, so a poller
 * that missed the header cannot double-card.
 */
function messageIdAllowsTextSql(param) {
  return `(
    ${param}::text = ''
    OR COALESCE(inbound_message_id, '') = ''
    OR lower(inbound_message_id) = ${param}
  )`;
}

async function inboundAlreadyRecorded(queryable, {
  clientId,
  platform,
  leadId,
  leadEmail,
  inboundMessage,
  messageId,
}) {
  const q = queryable && typeof queryable.query === 'function' ? queryable : db;
  const lid = leadId != null ? String(leadId) : '';
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  if (!lid && !email) return null;
  const mid = canonicalInboundMessageId(messageId);

  if (mid) {
    const byId = await q.query(
      `SELECT ${INBOUND_ROW_COLUMNS}
         FROM pending_replies
        WHERE /* inbound-message-id-match */ client_id = $1
          AND platform = $2
          AND COALESCE(classification, '') <> 'FOLLOW_UP'
          AND lower(COALESCE(inbound_message_id, '')) = $3
          AND ${samePersonSql('$4', '$5')}
        ORDER BY created_at DESC
        LIMIT 1`,
      [clientId, platform, mid, lid, email]
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  const normalized = inboundPrefix(inboundMessage);
  const fullNorm = normalizeInboundText(inboundMessage);
  if (!normalized) return null;

  const { rows } = await q.query(
    `SELECT ${INBOUND_ROW_COLUMNS}
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND ${messageIdAllowsTextSql('$7')}
        AND ${sameReplySql('$3', '$4')}
        AND ${samePersonSql('$5', '$6')}
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, platform, normalized, fullNorm, lid, email, mid]
  );
  if (rows[0]) return rows[0];

  return null;
}

async function alreadyPostedToSlack({
  clientId,
  platform,
  campaignId,
  leadId,
  leadEmail,
  inboundMessage,
  emailStatsId,
  messageId,
}) {
  // Text, or Message-ID. A SmartLead stats id is the latest SENT message and
  // is shared by later, different replies. Matching on it drops a real response.
  // emailStatsId and campaignId stay in the signature for callers.
  void emailStatsId;
  void campaignId;
  const row = await inboundAlreadyRecorded(db, {
    clientId, platform, leadId, leadEmail, inboundMessage, messageId,
  });
  return Boolean(row);
}

/**
 * Serialize webhook + poller inserts for the same inbound so both cannot
 * pass "not yet recorded" and create two pending_replies rows.
 */
function personLockKeys({ clientId, platform, leadId, leadEmail }) {
  const lid = leadId != null ? String(leadId) : '';
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const keys = [];
  if (lid) keys.push(`${clientId}|${platform}|id|${lid}`);
  if (email) keys.push(`${clientId}|${platform}|email|${email}`);
  if (!keys.length) keys.push(`${clientId}|${platform}|unknown`);
  keys.sort();
  return keys;
}

function sameNormalizedInbound(a, b) {
  if (!a || !b) return false;
  if (a.slice(0, PREFIX_LEN) === b.slice(0, PREFIX_LEN)) return true;
  return a.length >= MIN_CONTAINMENT_LEN
    && b.length >= MIN_CONTAINMENT_LEN
    && (a.startsWith(b) || b.startsWith(a));
}

/**
 * The duplicate copy is the same email and strictly longer once both sides
 * have been through normalizeInboundText. Upgrade the stored body. Do not
 * post again.
 */
async function upgradeFullerInbound(conn, existing, inboundMessage, messageId) {
  if (!existing?.id) return existing;
  const incoming = decodeInboundForStorage(inboundMessage);
  const mid = canonicalInboundMessageId(messageId);
  const storedNorm = normalizeInboundText(existing.inbound_message);
  const incomingNorm = normalizeInboundText(incoming);
  const fuller = Boolean(incoming)
    && incomingNorm.length > storedNorm.length
    && sameNormalizedInbound(storedNorm, incomingNorm);
  const backfillId = Boolean(mid) && !canonicalInboundMessageId(existing.inbound_message_id);
  if (!fuller && !backfillId) return existing;
  const nextText = fuller ? incoming : existing.inbound_message;
  const { rows } = await conn.query(
    `UPDATE pending_replies
        SET inbound_message = $1,
            inbound_message_id = COALESCE(NULLIF(inbound_message_id, ''), $2),
            updated_at = now()
      WHERE /* fuller-inbound */ id = $3
      RETURNING *`,
    [nextText, mid || null, existing.id]
  );
  return rows[0] || existing;
}

async function claimNewInbound({
  clientId,
  platform,
  leadId,
  leadEmail,
  inboundMessage,
  messageId,
}, insertFn, dbOverride) {
  const lockKeys = personLockKeys({ clientId, platform, leadId, leadEmail });
  const database = dbOverride || db;
  const conn = await database.connect();
  try {
    await conn.query('BEGIN');
    for (const key of lockKeys) {
      await conn.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [key, 'inbound-claim']
      );
    }
    // Message-ID first, inside the lock, before any text comparison.
    const existing = await inboundAlreadyRecorded(conn, {
      clientId, platform, leadId, leadEmail, inboundMessage, messageId,
    });
    if (existing) {
      const upgraded = await upgradeFullerInbound(conn, existing, inboundMessage, messageId);
      await conn.query('COMMIT');
      return { duplicate: true, existing: upgraded };
    }
    const reply = await insertFn(conn);
    await conn.query('COMMIT');
    return { duplicate: false, reply };
  } catch (err) {
    try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

function sameOutboundText(a, b) {
  const left = inboundPrefix(a);
  const right = inboundPrefix(b);
  if (left && left === right) return true;
  const fullA = normalizeInboundText(a);
  const fullB = normalizeInboundText(b);
  return fullA.length >= MIN_CONTAINMENT_LEN
    && fullB.length >= MIN_CONTAINMENT_LEN
    && (fullA.startsWith(fullB) || fullB.startsWith(fullA));
}

/** True when we already sent this same outbound text to this person. */
async function alreadySentSameOutbound({
  clientId,
  platform,
  leadId,
  leadEmail,
  replyText,
  exceptReplyId,
}) {
  const lid = leadId != null ? String(leadId) : '';
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  if (!lid && !email) return false;
  if (!String(replyText || '').trim()) return false;

  const { rows } = await db.query(
    `SELECT id, sent_reply
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND status = 'sent'
        AND id <> $3
        AND sent_reply IS NOT NULL
        AND trim(sent_reply) <> ''
        AND ${samePersonSql('$4', '$5')}
      ORDER BY updated_at DESC
      LIMIT 20`,
    [clientId, platform, exceptReplyId || '00000000-0000-0000-0000-000000000000', lid, email]
  );
  return rows.some((r) => sameOutboundText(r.sent_reply, replyText));
}

/** A sending row older than this can be claimed again (process died mid-send). */
const STALE_SENDING_MS = 10 * 60 * 1000;

/**
 * Legacy FOLLOW_UP cards have no step id. Two of them for the same person
 * inside this window are the double-card bug (Jeff Miller), not the next
 * cadence step. Cards that both carry a step are compared by step instead,
 * so approving step 1 and step 2 back to back still sends both.
 */
const LEGACY_FOLLOW_UP_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Whether this approve must not send.
 *
 * Assumes the rows are already the same person. Same text always blocks.
 * Same follow-up step (even when the model reworded the opening) blocks.
 * A different step of the same cadence does not.
 */
function outboundSendBlockedReason({ candidate, existing, now = Date.now() } = {}) {
  if (!existing || !candidate) return null;
  const status = String(existing.status || '');
  if (!['sending', 'sent', 'approved'].includes(status)) return null;
  if (status === 'sending' && existing.updatedAt) {
    const age = now - new Date(existing.updatedAt).getTime();
    if (Number.isFinite(age) && age > STALE_SENDING_MS) return null;
  }

  const candClass = String(candidate.classification || '').toUpperCase();
  const existClass = String(existing.classification || '').toUpperCase();
  const candMid = canonicalInboundMessageId(candidate.inboundMessageId);
  const existMid = canonicalInboundMessageId(existing.inboundMessageId);
  if (candClass !== 'FOLLOW_UP' && existClass !== 'FOLLOW_UP') {
    if (candMid && existMid && candMid === existMid) return 'same_inbound';
    const idsDiffer = Boolean(candMid && existMid && candMid !== existMid);
    if (!idsDiffer && candidate.inboundMessage && existing.inboundMessage) {
      const a = normalizeInboundText(candidate.inboundMessage);
      const b = normalizeInboundText(existing.inboundMessage);
      if (sameNormalizedInbound(a, b)) return 'same_inbound';
    }
  }

  const otherText = String(existing.sentReply || existing.draftReply || '');
  if (otherText && candidate.replyText && sameOutboundText(otherText, candidate.replyText)) {
    return 'same_text';
  }

  if (candClass !== 'FOLLOW_UP' || existClass !== 'FOLLOW_UP') return null;

  if (
    candidate.followUpId
    && existing.followUpId
    && String(candidate.followUpId) === String(existing.followUpId)
  ) {
    return 'same_follow_up';
  }

  const candStep = candidate.followUpStep == null || candidate.followUpStep === ''
    ? null
    : Number(candidate.followUpStep);
  const existStep = existing.followUpStep == null || existing.followUpStep === ''
    ? null
    : Number(existing.followUpStep);
  const candSource = candidate.sourcePendingReplyId ? String(candidate.sourcePendingReplyId) : '';
  const existSource = existing.sourcePendingReplyId ? String(existing.sourcePendingReplyId) : '';
  if (
    candStep != null
    && existStep != null
    && candStep === existStep
    && candSource
    && candSource === existSource
  ) {
    return 'same_step';
  }

  const legacy = candStep == null && existStep == null;
  if (legacy && status === 'sending') return 'in_flight';
  if (legacy && status === 'sent' && String(existing.sentReply || '').trim() && existing.updatedAt) {
    const age = now - new Date(existing.updatedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < LEGACY_FOLLOW_UP_WINDOW_MS) {
      return 'recent_follow_up';
    }
  }
  return null;
}

async function findBlockingOutbound(conn, reply, replyText) {
  const lid = reply.lead_id != null ? String(reply.lead_id) : '';
  const email = reply.lead_email ? String(reply.lead_email).trim().toLowerCase() : '';
  if (!lid && !email) return null;
  const { rows } = await conn.query(
    `SELECT id, status, classification, draft_reply, sent_reply,
            follow_up_step, follow_up_source_id, follow_up_id, updated_at,
            inbound_message, inbound_message_id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND id <> $3
        AND status IN ('sending', 'sent', 'approved')
        AND (status <> 'sending' OR updated_at >= now() - interval '10 minutes')
        AND ${samePersonSql('$4', '$5')}
      ORDER BY updated_at DESC
      LIMIT 30`,
    [reply.client_id, reply.platform, reply.id, lid, email]
  );
  for (const row of rows) {
    const reason = outboundSendBlockedReason({
      candidate: {
        classification: reply.classification,
        followUpStep: reply.follow_up_step,
        sourcePendingReplyId: reply.follow_up_source_id,
        followUpId: reply.follow_up_id,
        replyText,
        inboundMessage: reply.inbound_message,
        inboundMessageId: reply.inbound_message_id,
      },
      existing: {
        status: row.status,
        classification: row.classification,
        followUpStep: row.follow_up_step,
        sourcePendingReplyId: row.follow_up_source_id,
        followUpId: row.follow_up_id,
        sentReply: row.sent_reply,
        draftReply: row.draft_reply,
        updatedAt: row.updated_at,
        inboundMessage: row.inbound_message,
        inboundMessageId: row.inbound_message_id,
      },
    });
    if (reason) return { id: row.id, reason };
  }
  return null;
}

/**
 * Atomically claim a card before the platform send.
 *
 * Approve used to flip the row to `approved` and then look for an already
 * `sent` copy. Two cards for one follow-up (or two clicks at once) both
 * passed that check. The person lock plus status `sending` makes the second
 * caller see the first one in flight. A same-step follow-up blocks even when
 * the draft was reworded.
 */
async function claimOutboundSend({ replyId, replyText }, dbOverride) {
  if (!replyId) return { ok: true };
  const database = dbOverride || db;
  const conn = await database.connect();
  try {
    await conn.query('BEGIN');
    const { rows: [pre] } = await conn.query(
      'SELECT * FROM pending_replies WHERE id = $1',
      [replyId]
    );
    if (!pre) {
      await conn.query('COMMIT');
      return { ok: false, reason: 'missing_row' };
    }
    const keys = personLockKeys({
      clientId: pre.client_id,
      platform: pre.platform,
      leadId: pre.lead_id,
      leadEmail: pre.lead_email,
    });
    for (const key of keys) {
      await conn.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [key, 'outbound-send']
      );
    }
    const { rows: [current] } = await conn.query(
      'SELECT * FROM pending_replies WHERE id = $1 FOR UPDATE',
      [replyId]
    );
    if (!current) {
      await conn.query('COMMIT');
      return { ok: false, reason: 'missing_row' };
    }
    const staleSending = current.status === 'sending'
      && current.updated_at
      && (Date.now() - new Date(current.updated_at).getTime()) > STALE_SENDING_MS;
    const claimable = ['pending', 'flagged', 'approved'].includes(current.status) || staleSending;
    if (!claimable) {
      await conn.query('COMMIT');
      return { ok: false, reason: 'already_actioned', status: current.status };
    }
    await conn.query(
      `UPDATE pending_replies SET status = 'sending', updated_at = now() WHERE id = $1`,
      [replyId]
    );
    const blocker = await findBlockingOutbound(conn, current, replyText);
    if (blocker) {
      await conn.query(
        `UPDATE pending_replies SET status = 'skipped', updated_at = now() WHERE id = $1`,
        [replyId]
      );
      await conn.query('COMMIT');
      return { ok: false, reason: blocker.reason, existingId: blocker.id };
    }
    await conn.query('COMMIT');
    return { ok: true, reply: { ...current, status: 'sending' } };
  } catch (err) {
    try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

const SLACK_CLAIM_PREFIX = 'claiming:';
const SLACK_CLAIM_STALE_MINUTES = 2;

function slackClaimToken(replyId) {
  return `${SLACK_CLAIM_PREFIX}${replyId}`;
}

function isClaimedSlackTs(ts) {
  return String(ts || '').startsWith(SLACK_CLAIM_PREFIX);
}

function isPostedSlackTs(ts) {
  return Boolean(ts) && !isClaimedSlackTs(ts);
}

/**
 * Recover + webhook can both call postProspectSlackCard for the same row
 * (Philip Walker, 2026-10-05 — recover at :00, webhook at :04). Claim the
 * row before the Slack HTTP so only one path posts.
 *
 * FOLLOW_UP cadence cards reuse the original inbound text, so they skip the
 * sibling check. The row itself is still claimed so the same follow-up card
 * cannot post twice.
 */
async function siblingHasSlackCard({
  clientId,
  platform,
  leadId,
  leadEmail,
  inboundMessage,
  exceptReplyId,
  messageId,
  campaignId,
}) {
  const normalized = inboundPrefix(inboundMessage);
  const fullNorm = normalizeInboundText(inboundMessage);
  const lid = leadId != null ? String(leadId) : '';
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const mid = canonicalInboundMessageId(messageId);
  if (!normalized && !mid) return null;
  if (!lid && !email && !(campaignId != null && String(campaignId).trim())) return null;

  const { rows } = await db.query(
    `SELECT id, slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND id <> $3
        AND slack_message_ts IS NOT NULL
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND (
          ${samePersonSql('$6', '$7')}
          OR (
            $9::text <> ''
            AND length($4::text) >= ${CAMPAIGN_DEDUPE_MIN_LEN}
            AND COALESCE(campaign_id, '') = $9
            AND created_at > now() - interval '48 hours'
          )
        )
        AND (
          ($8::text <> '' AND lower(COALESCE(inbound_message_id, '')) = $8)
          OR (
            ${messageIdAllowsTextSql('$8')}
            AND ${sameReplySql('$4', '$5')}
          )
        )
      ORDER BY created_at ASC
      LIMIT 1`,
    [clientId, platform, exceptReplyId, normalized, fullNorm, lid, email, mid,
      platform === 'smartlead' && campaignId != null ? String(campaignId).trim() : '']
  );
  return rows[0] || null;
}

async function claimSlackCard({
  replyId,
  clientId,
  platform,
  leadId,
  leadEmail,
  inboundMessage,
  classification,
}) {
  if (!replyId) return { claimed: true };
  const token = slackClaimToken(replyId);

  const { rows: [row] } = await db.query(
    'SELECT slack_message_ts, inbound_message_id, inbound_message, campaign_id FROM pending_replies WHERE id = $1',
    [replyId]
  );
  if (!row) return { claimed: false, reason: 'missing_row' };
  if (isPostedSlackTs(row.slack_message_ts)) {
    return { claimed: false, reason: 'already_posted' };
  }
  if (isClaimedSlackTs(row.slack_message_ts) && row.slack_message_ts !== token) {
    return { claimed: false, reason: 'already_claimed' };
  }
  if (row.slack_message_ts === token) {
    return { claimed: true };
  }

  if (String(classification || '').toUpperCase() !== 'FOLLOW_UP') {
    const sibling = await siblingHasSlackCard({
      clientId,
      platform,
      leadId,
      leadEmail,
      inboundMessage: inboundMessage || row.inbound_message,
      exceptReplyId: replyId,
      messageId: row.inbound_message_id,
      campaignId: row.campaign_id,
    });
    if (sibling) {
      // This row is a second copy of a reply that already has a card. Close it
      // so the recovery sweep stops re-trying it every cycle.
      await db.query(
        `UPDATE pending_replies
            SET status = 'suppressed', suppression_reason = 'duplicate_of_posted_card', updated_at = now()
          WHERE id = $1 AND slack_message_ts IS NULL AND status IN ('pending', 'alert_only')`,
        [replyId]
      ).catch((err) => console.warn('[ReplyDedupe] could not close duplicate row', { err: err.message }));
      return { claimed: false, reason: 'sibling_posted' };
    }
  }

  const { rows: claimed } = await db.query(
    `UPDATE pending_replies
        SET slack_message_ts = $1, updated_at = now()
      WHERE id = $2
        AND (
          slack_message_ts IS NULL
          OR (
            slack_message_ts LIKE $3
            AND updated_at < now() - interval '${SLACK_CLAIM_STALE_MINUTES} minutes'
          )
        )
      RETURNING id`,
    [token, replyId, `${SLACK_CLAIM_PREFIX}%`]
  );
  if (!claimed[0]) {
    return { claimed: false, reason: 'lost_race' };
  }
  return { claimed: true };
}

async function releaseSlackCardClaim(replyId) {
  if (!replyId) return;
  await db.query(
    `UPDATE pending_replies
        SET slack_message_ts = NULL, updated_at = now()
      WHERE id = $1 AND slack_message_ts = $2`,
    [replyId, slackClaimToken(replyId)]
  );
}

async function findUnpostedReply({
  clientId,
  platform,
  campaignId,
  leadId,
  leadEmail,
  inboundMessage,
  emailStatsId,
  messageId,
}) {
  void emailStatsId;
  void campaignId;
  const normalized = inboundPrefix(inboundMessage);
  const fullNorm = normalizeInboundText(inboundMessage);
  const mid = canonicalInboundMessageId(messageId);
  if (!normalized && !mid) return null;

  // Skip rows created in the last ~2 minutes so the poller does not post a
  // placeholder card ahead of the webhook (persist-then-200, then async
  // classify/draft). After that window an unposted row is a real miss.
  //
  // Never recover FOLLOW_UP cadence rows here. Those store the original
  // prospect text as inbound_message and post to #followups-ai-replies via
  // follow-up-runner. Matching them as "unposted" re-posts the same reply
  // into the client inbox (often mid-race while the real FOLLOW_UP card is
  // still being written) — looks like the prospect said it twice / as if we
  // never replied. Measured 2026-09-04: Zach Walls "I'm not opposed".
  const { rows } = await db.query(
    `SELECT *
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND slack_message_ts IS NULL
        AND status IN ('pending', 'alert_only')
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND created_at < now() - interval '2 minutes'
        AND (
          ($7::text <> '' AND lower(COALESCE(inbound_message_id, '')) = $7)
          OR (
            ${messageIdAllowsTextSql('$7')}
            AND ${sameReplySql('$3', '$5')}
          )
        )
        AND (
          $4::text = ''
          OR COALESCE(lead_id, '') = $4
          OR ($6::text <> '' AND lower(COALESCE(lead_email, '')) = $6)
        )
      ORDER BY created_at ASC
      LIMIT 1`,
    [
      clientId,
      platform,
      normalized,
      leadId != null ? String(leadId) : '',
      fullNorm,
      leadEmail ? String(leadEmail).trim().toLowerCase() : '',
      mid,
    ]
  );
  return rows[0] || null;
}

function formatCampaignDisplayFromReply(reply) {
  return formatCampaignDisplay(campaignNameFromReply(reply), reply.campaign_id);
}

function lastOutboundFromThreadContext(reply) {
  let tc = reply.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (!tc) return '';
  const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
  if (reply.platform === 'smartlead') {
    return lastOutboundBodyFromSmartleadHistory(tc) || '';
  }
  const messages = Array.isArray(tc?.messages) ? tc.messages : [];
  let last = '';
  for (const m of messages) {
    const role = String(m?.role || '').toLowerCase();
    if (role === 'us' || role === 'me') {
      const t = m.message || m.text || m.body || '';
      if (String(t).trim()) last = String(t).trim();
    }
  }
  return last;
}

async function repostReplyRowToSlack(client, reply, { reasoningExtra } = {}) {
  // FOLLOW_UP cards belong in the dedicated follow-ups channel and are owned
  // by follow-up-runner. Re-posting them here threads a duplicate of the
  // original inbound into the client inbox — looks like we never replied.
  if (String(reply.classification || '').toUpperCase() === 'FOLLOW_UP') {
    console.log('[Dedupe] Skip Slack recovery — FOLLOW_UP cadence cards are not inbox recoveries', {
      replyId: reply.id,
    });
    return false;
  }

  const { shouldPostToSlackChannel } = require('../utils/slack-channel-policy');
  if (!shouldPostToSlackChannel({
    classification: reply.classification,
    inboundMessage: reply.inbound_message,
  })) {
    console.log('[Dedupe] Skip Slack recovery — not an interested-channel classification', {
      replyId: reply.id,
      classification: reply.classification,
    });
    return false;
  }

  const { extractReferredContacts } = require('../utils/referred-contact');
  const { ourIdentitiesFromThread } = require('../utils/reply-all');
  let threadForReferral = reply.thread_context;
  if (typeof threadForReferral === 'string') {
    try { threadForReferral = JSON.parse(threadForReferral); } catch { threadForReferral = null; }
  }
  const referredContacts = extractReferredContacts(reply.inbound_message, {
    prospectEmail: reply.lead_email,
    prospectName: reply.lead_name,
    ourEmails: ourIdentitiesFromThread(threadForReferral),
  });
  const policy = applyClientDraftPolicy(client, reply.lead_email, {
    classification: reply.classification,
    draft: reply.draft_reply,
    reasoning: reasoningExtra || `Recovered unposted Slack card for ${reply.lead_name}.`,
  });
  if (policy.skippedDraft && reply.draft_reply) {
    await db.query(
      `UPDATE pending_replies
          SET draft_reply = NULL, status = 'alert_only', updated_at = now()
        WHERE id = $1`,
      [reply.id]
    );
  }
  const isDraft = policy.isDraft;
  const card = {
    replyId: reply.id,
    leadName: reply.lead_name,
    leadEmail: reply.lead_email,
    linkedinUrl: reply.linkedin_url || undefined,
    leadWebsite: reply.lead_website || undefined,
    leadPhoneAlt: reply.lead_phone_alt || undefined,
    leadLocation: reply.lead_location || undefined,
    leadTimezone: reply.lead_timezone || undefined,
    leadFullName: reply.lead_full_name || undefined,
    platform: reply.platform,
    classification: reply.classification,
    draft: policy.draft,
    reasoning: policy.reasoning,
    needsReview: reply.status === 'flagged' || /needs review/i.test(String(policy.reasoning || '')),
    inboundMessage: reply.inbound_message,
    campaignDisplay: formatCampaignDisplayFromReply(reply),
    lastOutboundMessage: lastOutboundFromThreadContext(reply) || undefined,
    referredContacts,
  };

  const posted = await postProspectSlackCard({
    token: client.slack_bot_token,
    channelId: client.slack_channel_id,
    clientId: client.id,
    platform: reply.platform,
    campaignId: reply.campaign_id,
    leadId: reply.lead_id,
    threadContext: reply.thread_context,
    isDraft,
    replyId: reply.id,
    card,
  });
  return !posted?.skipped;
}

/** Retry any DB rows that never made it to Slack (e.g. Slack API error after insert). */
async function recoverUnpostedSlackCards({ limit = 25 } = {}) {
  const { rows } = await db.query(
    `SELECT pr.*, c.slack_bot_token, c.slack_channel_id, c.name AS client_name
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE (
          pr.slack_message_ts IS NULL
          OR (
            pr.slack_message_ts LIKE 'claiming:%'
            AND pr.updated_at < now() - interval '2 minutes'
          )
        )
        AND pr.status IN ('pending', 'alert_only')
        AND pr.classification IN ('INTERESTED', 'MEETING_PROPOSED', 'QUESTION')
        AND c.active IS DISTINCT FROM false
        AND pr.created_at > now() - interval '7 days'
        AND pr.created_at < now() - interval '2 minutes'
      ORDER BY pr.created_at ASC
      LIMIT $1`,
    [limit]
  );

  let recovered = 0;
  for (const row of rows) {
    const client = {
      id: row.client_id,
      name: row.client_name,
      slack_bot_token: row.slack_bot_token,
      slack_channel_id: row.slack_channel_id,
    };
    try {
      const posted = await repostReplyRowToSlack(client, row, {
        reasoningExtra: 'Recovered: reply was saved but never posted to Slack.',
      });
      if (!posted) {
        console.log('[ReplyDedupe] Slack recovery skipped — already claimed or posted', {
          replyId: row.id, lead: row.lead_name,
        });
        continue;
      }
      recovered++;
      console.log('[ReplyDedupe] Recovered unposted Slack card', {
        replyId: row.id, client: client.name, lead: row.lead_name,
      });
    } catch (err) {
      console.error('[ReplyDedupe] Failed to recover unposted card', {
        replyId: row.id, lead: row.lead_name, err: err.message,
      });
    }
  }
  return { recovered, scanned: rows.length };
}

module.exports = {
  PREFIX_LEN,
  inboundPrefix,
  normalizeInboundText,
  decodeInboundForStorage,
  stripInboundRenderArtifacts,
  stripEmbeddedBinaries,
  canonicalInboundMessageId,
  sameReplySql,
  samePersonSql,
  DASH_CODEPOINTS,
  sameOutboundText,
  sameNormalizedInbound,
  MIN_CONTAINMENT_LEN,
  STORED_PREFIX_SQL,
  STORED_NORM_SQL,
  UNICODE_SPACE_CODEPOINTS,
  inboundAlreadyRecorded,
  alreadyPostedToSlack,
  claimNewInbound,
  upgradeFullerInbound,
  claimSlackCard,
  releaseSlackCardClaim,
  alreadySentSameOutbound,
  outboundSendBlockedReason,
  claimOutboundSend,
  STALE_SENDING_MS,
  LEGACY_FOLLOW_UP_WINDOW_MS,
  findUnpostedReply,
  repostReplyRowToSlack,
  recoverUnpostedSlackCards,
  SLACK_CLAIM_PREFIX,
  isPostedSlackTs,
  isClaimedSlackTs,
};
