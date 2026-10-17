/**
 * Allo cold-call bookings → #meetings-booked Slack cards + recap counts.
 *
 * Confirmed = "Meeting Booked" tag. Likely = summary/transcript fallback
 * (shown on the card, not counted as confirmed in recaps). Dedupes against
 * email/Calendly meetings on email or phone within ALLO_MEETING_DEDUPE_HOURS.
 */

const db = require('../db');
const allo = require('./allo');
const slack = require('./slack');
const { resolveClientHint } = require('../utils/allo-client-map');
const {
  inspectCallBooking,
  salesgliderCalendlyUrl,
  isManualBookClient,
  isSalesGliderClient,
} = require('../utils/allo-call-booking');
const { phoneKey } = require('./allo');

const SOURCE_ALLO = 'allo_call';
const SOURCE_EMAIL = 'email';
const DEFAULT_CHANNEL_ID = 'C0BRBK7H4BF';
const DEFAULT_DEDUPE_HOURS = 72;
const TOPICS = new Set(['call.completed', 'tag.added']);

function meetingsBookedChannelId(env = process.env) {
  return String(env.MEETINGS_BOOKED_SLACK_CHANNEL_ID || '').trim() || DEFAULT_CHANNEL_ID;
}

function dedupeHours(env = process.env) {
  const n = parseInt(env.ALLO_MEETING_DEDUPE_HOURS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEDUPE_HOURS;
}

function recapsEnabled(env = process.env) {
  const v = env.MEETINGS_BOOKED_RECAP_ENABLED;
  if (v === undefined || v === '') return true;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function extraTagFromEvent(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return data.tag_name || data.tag_key || data.tag || null;
}

function callIdFromEvent(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return String(data.id || data.call_id || '').trim();
}

function mergeCall(base, extra) {
  if (!extra || typeof extra !== 'object') return base || {};
  return {
    ...(base || {}),
    ...extra,
    tags: extra.tags || base?.tags,
    transcript: extra.transcript || extra.transcriptions || base?.transcript || base?.transcriptions,
    person: extra.person || base?.person,
    extracted_data: extra.extracted_data || base?.extracted_data,
  };
}

async function findClientByName(name) {
  const want = String(name || '').trim();
  if (!want) return null;
  const { rows } = await db.query(
    `SELECT id, name, slack_bot_token, slack_channel_id, booking_link, voice_prompt
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND (
          lower(name) = lower($1)
          OR regexp_replace(lower(name), '[^a-z0-9]', '', 'g')
             = regexp_replace(lower($1), '[^a-z0-9]', '', 'g')
        )
      ORDER BY name ASC
      LIMIT 1`,
    [want]
  );
  return rows[0] || null;
}

async function slackTokenFor(client, env = process.env) {
  const fromEnv = String(env.MEETINGS_BOOKED_SLACK_BOT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (client?.slack_bot_token) return client.slack_bot_token;
  const { rows } = await db.query(
    `SELECT slack_bot_token FROM clients
      WHERE active IS DISTINCT FROM false
        AND slack_bot_token IS NOT NULL
        AND trim(slack_bot_token) <> ''
      ORDER BY CASE WHEN lower(name) LIKE '%salesglider%' THEN 0 ELSE 1 END, name ASC
      LIMIT 1`
  );
  return rows[0]?.slack_bot_token || '';
}

async function claimWebhookId(webhookId, topic, callId) {
  if (!webhookId) return { inserted: true };
  const { rows } = await db.query(
    `INSERT INTO allo_webhook_events (webhook_id, topic, call_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (webhook_id) DO NOTHING
     RETURNING webhook_id`,
    [webhookId, topic || null, callId || null]
  );
  return { inserted: rows.length > 0 };
}

async function releaseWebhookId(webhookId) {
  if (!webhookId) return;
  await db.query('DELETE FROM allo_webhook_events WHERE webhook_id = $1', [webhookId]);
}

async function findDuplicateMeeting({
  clientId, email, phone, hours, excludeCallId,
}) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const phoneNorm = phoneKey(phone);
  if (!emailNorm && !phoneNorm) return null;
  const { rows } = await db.query(
    `SELECT id, source, source_confidence, allo_call_id, slack_message_ts, status
       FROM meetings
      WHERE client_id = $1
        AND created_at > now() - ($2::int * interval '1 hour')
        AND status IN ('proposed', 'confirmed', 'booked')
        AND (
          ($3::text <> '' AND lower(COALESCE(lead_email, '')) = $3)
          OR ($4::text <> '' AND right(regexp_replace(COALESCE(lead_phone, ''), '\\D', '', 'g'), 10) = $4)
        )
        AND ($5::text = '' OR COALESCE(allo_call_id, '') IS DISTINCT FROM $5)
      ORDER BY
        CASE WHEN COALESCE(source_confidence, 'confirmed') = 'confirmed' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 1`,
    [clientId, hours, emailNorm, phoneNorm, String(excludeCallId || '')]
  );
  return rows[0] || null;
}

function sourceLabel(source, confidence) {
  const allo = source === SOURCE_ALLO || source === 'allo';
  const base = allo ? 'Allo call' : 'email';
  if (confidence === 'likely') return `${base} · likely`;
  return base;
}

function buildMeetingsBookedCard(booking) {
  const clientName = booking.clientName || 'Unknown client';
  const likely = booking.confidence === 'likely';
  const source = sourceLabel(booking.source || SOURCE_ALLO, booking.confidence);
  const header = likely
    ? '📅 Likely meeting booked'
    : '📅 Meeting booked';
  const times = Array.isArray(booking.proposedTimes) ? booking.proposedTimes : [];
  const kind = booking.prospectKind === 'placeholder' ? 'placeholder' : 'interested';
  const lines = [
    `*Client:* ${clientName}`,
    `*Source:* ${source}`,
    `*Prospect:* ${booking.leadName || 'Unknown'}`,
    booking.leadPhone ? `*Phone:* ${booking.leadPhone}` : null,
    booking.leadEmail ? `*Email:* ${booking.leadEmail}` : null,
    times.length ? `*Proposed times:* ${times.join(' · ')}` : null,
    `*Prospect type:* ${kind}`,
  ].filter(Boolean);

  if (isSalesGliderClient(clientName)) {
    lines.push(`*Booking:* ${salesgliderCalendlyUrl()}`);
  } else if (isManualBookClient(clientName)) {
    lines.push('_No booking link — caller collects two times + email; Josh books by hand._');
  }

  if (likely) {
    lines.push('_Likely from call summary/transcript — not counted as confirmed in recaps._');
  }
  if (booking.summary) {
    const clip = String(booking.summary).replace(/\s+/g, ' ').trim().slice(0, 500);
    lines.push(`*Summary:* ${clip}`);
  }

  const text = `${header} — ${clientName} — ${booking.leadName || 'prospect'} (${source})`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    ],
  };
}

async function postMeetingsBookedCard(booking, { token, channelId } = {}) {
  const tok = token || await slackTokenFor(booking.client);
  const channel = channelId || meetingsBookedChannelId();
  if (!tok || !channel) {
    console.warn('[AlloMeetings] Slack not configured — card skipped', {
      hasToken: Boolean(tok), channel,
    });
    return null;
  }
  const card = buildMeetingsBookedCard(booking);
  return slack.postBlocks(tok, channel, card);
}

async function upsertAlloMeeting(row) {
  const { rows: [existing] } = await db.query(
    `SELECT * FROM meetings WHERE allo_call_id = $1 LIMIT 1`,
    [row.alloCallId]
  );

  const status = row.confidence === 'confirmed' ? 'booked' : 'proposed';
  const confirmedTime = row.confidence === 'confirmed' ? (row.occurredAt || new Date()) : null;
  const proposed = row.proposedTimes?.length ? row.proposedTimes.join('; ') : null;

  if (existing) {
    const prevConf = existing.source_confidence || 'confirmed';
    const upgrade = prevConf === 'likely' && row.confidence === 'confirmed';
    await db.query(
      `UPDATE meetings
          SET status = CASE WHEN $2 = 'confirmed' THEN 'booked' ELSE status END,
              source_confidence = CASE
                WHEN $2 = 'confirmed' THEN 'confirmed'
                ELSE COALESCE(source_confidence, $2)
              END,
              lead_name = COALESCE($3, lead_name),
              lead_email = COALESCE($4, lead_email),
              lead_phone = COALESCE($5, lead_phone),
              proposed_time = COALESCE($6, proposed_time),
              proposed_times = COALESCE($7::jsonb, proposed_times),
              prospect_kind = COALESCE($8, prospect_kind),
              allo_user_email = COALESCE($9, allo_user_email),
              allo_tags = COALESCE($10::text[], allo_tags),
              confirmed_time = CASE
                WHEN $2 = 'confirmed' THEN COALESCE(confirmed_time, $11::timestamptz, now())
                ELSE confirmed_time
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        row.confidence,
        row.leadName || null,
        row.leadEmail || null,
        row.leadPhone || null,
        proposed,
        row.proposedTimes ? JSON.stringify(row.proposedTimes) : null,
        row.prospectKind || null,
        row.alloUserEmail || null,
        row.tags || null,
        confirmedTime,
      ]
    );
    return { meetingId: existing.id, created: false, upgrade, alreadyPosted: Boolean(existing.slack_message_ts) };
  }

  const { rows: [inserted] } = await db.query(
    `INSERT INTO meetings
      (client_id, pending_reply_id, lead_name, lead_email, lead_phone, linkedin_url,
       proposed_time, proposed_times, confirmed_time, status, source, source_confidence,
       allo_call_id, allo_webhook_id, allo_user_email, allo_tags, prospect_kind)
     VALUES ($1, NULL, $2, $3, $4, NULL, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15)
     RETURNING id`,
    [
      row.clientId,
      row.leadName || null,
      row.leadEmail || null,
      row.leadPhone || null,
      proposed,
      JSON.stringify(row.proposedTimes || []),
      confirmedTime,
      status,
      SOURCE_ALLO,
      row.confidence,
      row.alloCallId,
      row.webhookId || null,
      row.alloUserEmail || null,
      row.tags || [],
      row.prospectKind || null,
    ]
  );
  return { meetingId: inserted.id, created: true, upgrade: false, alreadyPosted: false };
}

async function markSlackPosted(meetingId, channelId, ts) {
  await db.query(
    `UPDATE meetings
        SET slack_channel_id = $2, slack_message_ts = $3, updated_at = now()
      WHERE id = $1`,
    [meetingId, channelId || null, ts || null]
  );
}

async function cancelFollowUpsForCall({ clientId, email, phone, name }) {
  let cancelled = 0;
  if (email) {
    const { stopFollowUpsForEmail } = require('./booking-bridge');
    const r = await stopFollowUpsForEmail({
      clientId,
      email,
      name,
      skipReason: 'meeting_booked_allo',
    });
    cancelled += r.cancelledFollowUps || 0;
  }
  if (phone) {
    const key = phoneKey(phone);
    if (key) {
      const byPhone = await db.query(
        `UPDATE outbound_follow_ups f
            SET status = 'skipped',
                skip_reason = 'meeting_booked_allo',
                updated_at = now()
          WHERE f.client_id = $1
            AND f.status = 'pending'
            AND EXISTS (
              SELECT 1 FROM pending_replies pr
               WHERE pr.client_id = f.client_id
                 AND right(regexp_replace(COALESCE(pr.lead_phone, ''), '\\D', '', 'g'), 10) = $2
                 AND (
                   (pr.lead_id IS NOT NULL AND pr.lead_id = f.lead_id)
                   OR (pr.lead_email IS NOT NULL AND lower(pr.lead_email) = lower(COALESCE(f.lead_email, '')))
                 )
            )`,
        [clientId, key]
      );
      cancelled += byPhone.rowCount || 0;
    }
  }
  return cancelled;
}

/**
 * Handle one verified Allo webhook envelope.
 * @returns {Promise<object>}
 */
async function handleAlloWebhookEvent(event, {
  webhookId = null,
  fetchCall = allo.getCallById,
  postCard = postMeetingsBookedCard,
  env = process.env,
} = {}) {
  const topic = String(event?.topic || '').trim();
  if (!TOPICS.has(topic)) {
    return { ok: true, skipped: 'ignored_topic', topic };
  }

  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const extraTag = extraTagFromEvent(event);
  if (topic === 'tag.added' && extraTag && !/meeting[\s_-]*booked/i.test(String(extraTag))) {
    return { ok: true, skipped: 'unrelated_tag', tag: extraTag };
  }

  let call = topic === 'call.completed' ? data : { id: data.call_id, user_email: data.user_email };
  const callId = callIdFromEvent(event) || String(call.id || '').trim();

  const claimed = await claimWebhookId(webhookId, topic, callId);
  if (!claimed.inserted) {
    return { ok: true, skipped: 'duplicate_webhook', webhookId, callId };
  }

  try {
    if (topic === 'tag.added' && callId && typeof fetchCall === 'function') {
      try {
        const fetched = await fetchCall(callId);
        call = mergeCall(call, fetched);
      } catch (err) {
        console.warn('[AlloMeetings] fetch call failed — using tag payload', {
          callId, err: err.message,
        });
      }
    }
    if (!call.id && callId) call.id = callId;

    const hint = resolveClientHint(call, event, env);
    if (!hint.clientName) {
      console.warn('[AlloMeetings] No client mapped for Allo number/user', {
        alloNumber: hint.alloNumber,
        user: call.user_email || data.user_email || null,
        callId,
      });
      return { ok: true, skipped: 'unmapped_client', callId, alloNumber: hint.alloNumber };
    }

    const client = await findClientByName(hint.clientName);
    if (!client) {
      console.warn('[AlloMeetings] Mapped client not in DB', { name: hint.clientName, callId });
      return { ok: true, skipped: 'client_not_found', clientName: hint.clientName, callId };
    }

    const inspected = inspectCallBooking(call, { extraTag });
    if (!inspected.booked) {
      return {
        ok: true,
        skipped: 'not_a_booking',
        callId,
        clientName: client.name,
      };
    }

    const dup = await findDuplicateMeeting({
      clientId: client.id,
      email: inspected.email,
      phone: hint.prospectNumber,
      hours: dedupeHours(env),
      excludeCallId: callId,
    });
    if (dup && (dup.source === SOURCE_EMAIL || dup.source === 'calendly' || dup.source_confidence === 'confirmed')) {
      if (inspected.confidence === 'confirmed' && callId) {
        await upsertAlloMeeting({
          clientId: client.id,
          alloCallId: callId,
          webhookId,
          confidence: 'confirmed',
          leadName: inspected.name,
          leadEmail: inspected.email,
          leadPhone: hint.prospectNumber,
          proposedTimes: inspected.proposedTimes,
          prospectKind: inspected.prospectKind,
          alloUserEmail: hint.via === 'user_email' ? (call.user_email || data.user_email) : (call.user_email || null),
          tags: inspected.tags,
          occurredAt: call.start_date || event.timestamp || null,
        });
      }
      return {
        ok: true,
        skipped: 'duplicate_email_or_phone',
        callId,
        duplicateOf: dup.id,
        source: dup.source,
      };
    }

    const saved = await upsertAlloMeeting({
      clientId: client.id,
      alloCallId: callId,
      webhookId,
      confidence: inspected.confidence,
      leadName: inspected.name,
      leadEmail: inspected.email,
      leadPhone: hint.prospectNumber,
      proposedTimes: inspected.proposedTimes,
      prospectKind: inspected.prospectKind,
      alloUserEmail: call.user_email || data.user_email || null,
      tags: inspected.tags,
      occurredAt: call.start_date || event.timestamp || null,
    });

    const booking = {
      client,
      clientName: client.name,
      source: SOURCE_ALLO,
      confidence: inspected.confidence,
      leadName: inspected.name,
      leadEmail: inspected.email,
      leadPhone: hint.prospectNumber,
      proposedTimes: inspected.proposedTimes,
      prospectKind: inspected.prospectKind,
      summary: inspected.summary,
      callId,
    };

    let slackTs = null;
    const shouldPost = !saved.alreadyPosted || saved.upgrade;
    if (shouldPost && typeof postCard === 'function') {
      const posted = await postCard(booking);
      slackTs = posted?.ts || null;
      if (slackTs) {
        await markSlackPosted(saved.meetingId, meetingsBookedChannelId(env), slackTs);
      }
    }

    if (inspected.confidence === 'confirmed') {
      await cancelFollowUpsForCall({
        clientId: client.id,
        email: inspected.email,
        phone: hint.prospectNumber,
        name: inspected.name,
      });
    }

    return {
      ok: true,
      topic,
      callId,
      clientName: client.name,
      source: SOURCE_ALLO,
      confidence: inspected.confidence,
      prospectKind: inspected.prospectKind,
      meetingId: saved.meetingId,
      created: saved.created,
      upgrade: saved.upgrade,
      slackTs,
      card: buildMeetingsBookedCard(booking),
    };
  } catch (err) {
    await releaseWebhookId(webhookId);
    throw err;
  }
}

function clientSlug(name) {
  const { slugFromClientName } = require('./booking-bridge');
  return slugFromClientName(name);
}

function recapDedupeKey(row) {
  const slug = clientSlug(row.client_name || row.clientName || '');
  const email = String(row.lead_email || row.leadEmail || '').trim().toLowerCase();
  const phone = phoneKey(row.lead_phone || row.leadPhone || '');
  return `${slug}|${email || phone || String(row.id || row.lead_name || '')}`;
}

function partitionRecapMeetings(rows) {
  const seenConfirmed = new Set();
  const confirmed = [];
  const likely = [];
  const ranked = [...rows].sort((a, b) => {
    const ac = (a.source_confidence || 'confirmed') === 'confirmed' ? 0 : 1;
    const bc = (b.source_confidence || 'confirmed') === 'confirmed' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
  for (const row of ranked) {
    const key = recapDedupeKey(row);
    const conf = row.source_confidence || 'confirmed';
    if (conf === 'likely') {
      if (seenConfirmed.has(key)) continue;
      likely.push(row);
      continue;
    }
    if (seenConfirmed.has(key)) continue;
    seenConfirmed.add(key);
    confirmed.push(row);
  }
  return { confirmed, likely };
}

function serializeRecapMeeting(row) {
  const source = row.source === SOURCE_ALLO || row.source === 'allo' ? SOURCE_ALLO : SOURCE_EMAIL;
  const confidence = row.source_confidence || 'confirmed';
  return {
    client_name: row.client_name || null,
    slug: clientSlug(row.client_name),
    lead_name: row.lead_name || null,
    lead_email: row.lead_email || null,
    lead_phone: row.lead_phone || null,
    source,
    source_label: sourceLabel(source, confidence),
    source_confidence: confidence,
    prospect_kind: row.prospect_kind || null,
    proposed_times: row.proposed_times || null,
    created_at: row.created_at,
  };
}

async function loadMeetingsForWindow({ startIso, endIso }) {
  const { rows } = await db.query(
    `SELECT m.id, m.lead_name, m.lead_email, m.lead_phone, m.source, m.source_confidence,
            m.prospect_kind, m.proposed_times, m.created_at, m.status, c.name AS client_name
       FROM meetings m
       JOIN clients c ON c.id = m.client_id
      WHERE m.created_at >= $1::timestamptz
        AND m.created_at < $2::timestamptz
        AND m.status IN ('proposed', 'confirmed', 'booked')
        AND (
          COALESCE(m.source_confidence, 'confirmed') = 'confirmed'
          OR COALESCE(m.source_confidence, '') = 'likely'
        )
      ORDER BY c.name ASC, m.created_at ASC`,
    [startIso, endIso]
  );
  return rows;
}

function recapCountsFromRows(rows) {
  const { confirmed, likely } = partitionRecapMeetings(rows);
  const bySource = { email: 0, allo_call: 0 };
  for (const row of confirmed) {
    const source = row.source === SOURCE_ALLO || row.source === 'allo' ? SOURCE_ALLO : SOURCE_EMAIL;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  return {
    confirmed: confirmed.length,
    likely: likely.length,
    by_source: bySource,
    meetings: confirmed.map(serializeRecapMeeting),
    likely_meetings: likely.map(serializeRecapMeeting),
  };
}

function prospectLine(row) {
  if (row.lead_name && row.lead_email) return `${row.lead_name} (${row.lead_email})`;
  if (row.lead_name && row.lead_phone) return `${row.lead_name} (${row.lead_phone})`;
  return row.lead_name || row.lead_email || row.lead_phone || 'Unknown prospect';
}

function buildMeetingsRecapText({
  period, label, clients, meetings, likelyMeetings,
}) {
  const confirmedBy = new Map();
  for (const row of meetings || []) {
    const slug = row.slug || clientSlug(row.client_name);
    const list = confirmedBy.get(slug) || [];
    list.push(row);
    confirmedBy.set(slug, list);
  }
  const likelyBy = new Map();
  for (const row of likelyMeetings || []) {
    const slug = row.slug || clientSlug(row.client_name);
    const list = likelyBy.get(slug) || [];
    list.push(row);
    likelyBy.set(slug, list);
  }
  const slugs = [...new Set([
    ...(clients || []).map((c) => c.slug || clientSlug(c.name)),
    ...confirmedBy.keys(),
    ...likelyBy.keys(),
  ])].filter(Boolean);

  const nameOf = (slug) => {
    const c = (clients || []).find((x) => (x.slug || clientSlug(x.name)) === slug);
    const sample = (confirmedBy.get(slug) || likelyBy.get(slug) || [])[0];
    return c?.name || sample?.client_name || slug;
  };

  const blocks = slugs.sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((slug) => {
    const booked = confirmedBy.get(slug) || [];
    const likely = likelyBy.get(slug) || [];
    const lines = [`*${nameOf(slug)}*`];
    lines.push(`Meetings booked: ${booked.length}`);
    for (const row of booked) {
      lines.push(`• ${prospectLine(row)} — ${row.source_label || sourceLabel(row.source, row.source_confidence)}`);
    }
    if (likely.length) {
      lines.push(`Likely (not confirmed): ${likely.length}`);
      for (const row of likely) {
        lines.push(`• ${prospectLine(row)} — ${row.source_label || sourceLabel(row.source, 'likely')}`);
      }
    }
    return lines.join('\n');
  });

  const title = period === 'week'
    ? `:bar_chart: *Weekly recap — ${label}*`
    : `:bar_chart: *Daily recap — ${label}*`;
  const likelyTotal = (likelyMeetings || []).length;
  const likelyLine = likelyTotal
    ? `, ${likelyTotal} likely`
    : '';
  return [
    title,
    '',
    ...blocks,
    '',
    `*Total:* ${(meetings || []).length} meetings${likelyLine} (Allo call vs email labeled above)`,
  ].join('\n');
}

const RECAP_TZ = 'America/Chicago';

function ymdInTz(date = new Date(), tz = RECAP_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function weekdayInTz(date = new Date(), tz = RECAP_TZ) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function mondayOf(ymd, weekday) {
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const n = idx[weekday] ?? 1;
  return addDaysYmd(ymd, n === 0 ? -6 : 1 - n);
}

function offsetAt(ymd, tz = RECAP_TZ) {
  const probe = new Date(`${ymd}T12:00:00.000Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, timeZoneName: 'shortOffset', hour: '2-digit',
  }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '-05:00';
  return `${m[1]}${String(m[2]).padStart(2, '0')}:${m[3] || '00'}`;
}

function prettyDate(ymd, tz = RECAP_TZ) {
  const d = new Date(`${ymd}T12:00:00${offsetAt(ymd, tz)}`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}

function recapWindow(period, now = new Date()) {
  const today = ymdInTz(now);
  const weekday = weekdayInTz(now);
  const startYmd = period === 'week' ? mondayOf(today, weekday) : today;
  const endYmd = addDaysYmd(today, 1);
  return {
    startYmd,
    endYmd: today,
    startIso: `${startYmd}T00:00:00${offsetAt(startYmd)}`,
    endIso: `${endYmd}T00:00:00${offsetAt(endYmd)}`,
    label: period === 'week'
      ? `this week (${prettyDate(startYmd)} – ${prettyDate(today)})`
      : prettyDate(today),
  };
}

async function postMeetingsRecap({ period, label, startIso, endIso, clients }) {
  const rows = await loadMeetingsForWindow({ startIso, endIso });
  const counts = recapCountsFromRows(rows);
  let clientList = clients;
  if (!clientList) {
    const { rows: crows } = await db.query(
      `SELECT id, name FROM clients
        WHERE active IS DISTINCT FROM false
        ORDER BY name ASC`
    );
    clientList = crows;
  }
  const text = buildMeetingsRecapText({
    period,
    label,
    clients: clientList,
    meetings: counts.meetings,
    likelyMeetings: counts.likely_meetings,
  });
  const token = await slackTokenFor(null);
  const channel = meetingsBookedChannelId();
  if (!token || !channel) {
    console.warn('[AlloMeetings] Recap Slack not configured');
    return { ...counts, posted: false, text };
  }
  await slack.postBlocks(token, channel, { text, blocks: null });
  return { ...counts, posted: true, text };
}

module.exports = {
  SOURCE_ALLO,
  SOURCE_EMAIL,
  DEFAULT_CHANNEL_ID,
  DEFAULT_DEDUPE_HOURS,
  TOPICS,
  meetingsBookedChannelId,
  dedupeHours,
  recapsEnabled,
  sourceLabel,
  buildMeetingsBookedCard,
  postMeetingsBookedCard,
  handleAlloWebhookEvent,
  recapCountsFromRows,
  partitionRecapMeetings,
  serializeRecapMeeting,
  loadMeetingsForWindow,
  buildMeetingsRecapText,
  postMeetingsRecap,
  recapWindow,
  RECAP_TZ,
};
