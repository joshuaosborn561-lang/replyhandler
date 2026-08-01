const db = require('../db');
const smartlead = require('./smartlead');
const { classifyFromSmartlead, extractCategory } = require('./smartlead-category');
const { looksAlreadyBooked } = require('./booking-check');
const { replySuppressesFollowUp } = require('../utils/booking-signals');
const {
  fetchInboxReplies, historyFromRow, latestInboundFromRow, replyTime,
} = require('./smartlead-poller');
const { cleanInboundReply } = require('../utils/smartlead-webhook-helpers');

/**
 * Sweep every client's SmartLead inbox for replies SmartLead itself marked
 * Interested (or Meeting Request), then judge which of them actually booked.
 *
 * Answers "who booked today?" without opening SmartLead per campaign. Reads
 * only — nothing is stored and nothing posts to Slack.
 *
 * A booked verdict is evidence-based, never a guess: a meetings row, a
 * calendar event with them on it, a later reply proposing or confirming a
 * time, or a call transcript. Each result says which.
 */

const INTERESTED = new Set(['INTERESTED', 'MEETING_PROPOSED']);

function confidence(signals) {
  if (signals.includes('meeting_row_exists')) return 'confirmed';
  if (signals.includes('calendar_event_found')) return 'confirmed';
  if (signals.includes('call_transcript_booked')) return 'likely';
  if (signals.includes('prospect_says_booked')) return 'likely';
  if (signals.includes('prospect_proposed_time')) return 'proposed a time';
  return 'no evidence';
}

async function sweepInterested({ hours = 24, pages = 4, pageSize = 50 } = {}) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const { rows: clients } = await db.query(
    `SELECT id, name, smartlead_api_key FROM clients
      WHERE active IS DISTINCT FROM false AND smartlead_api_key IS NOT NULL`
  );

  const booked = [];
  const notBooked = [];
  const errors = [];
  let scanned = 0;
  let interested = 0;

  for (const client of clients) {
    for (let page = 0; page < pages; page += 1) {
      let payload;
      try {
        payload = await fetchInboxReplies(client.smartlead_api_key, page * pageSize, pageSize);
      } catch (err) {
        errors.push({ client: client.name, err: err.message });
        break;
      }
      const rows = payload?.data || payload?.messages || [];
      if (!Array.isArray(rows) || !rows.length) break;

      for (const row of rows) {
        scanned += 1;
        const at = replyTime(row);
        if (at && at.getTime() < cutoff) continue;

        const category = extractCategory(row);
        const mapped = classifyFromSmartlead(row);
        if (!mapped || !INTERESTED.has(mapped.classification)) continue;
        interested += 1;

        const leadName = `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim() || 'Unknown';
        const leadEmail = row.lead_email || null;
        const leadId = row.email_lead_id || row.lead_id || null;
        const inbound = cleanInboundReply(latestInboundFromRow(row) || '');

        const signals = [];
        try {
          const reason = await looksAlreadyBooked(client.id, {
            platform: 'smartlead', leadEmail, leadName, leadId, since: at || new Date(cutoff),
          });
          if (reason) signals.push(reason);
        } catch (err) {
          errors.push({ client: client.name, lead: leadName, err: err.message });
        }
        // Their own words, independent of the stored-reply lookup above.
        const fromText = replySuppressesFollowUp(inbound);
        if (fromText && !signals.includes(fromText)) signals.push(fromText);

        const entry = {
          client: client.name,
          lead: leadName,
          email: leadEmail,
          smartleadCategory: category || null,
          repliedAt: at ? at.toISOString() : null,
          signals,
          confidence: confidence(signals),
          reply: inbound.slice(0, 300),
        };
        (signals.length ? booked : notBooked).push(entry);
      }

      if (rows.length < pageSize) break;
    }
  }

  const rank = { confirmed: 0, likely: 1, 'proposed a time': 2 };
  booked.sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9));

  return {
    hours,
    clientsScanned: clients.length,
    repliesScanned: scanned,
    interestedFound: interested,
    likelyBooked: booked,
    interestedNoBookingEvidence: notBooked,
    errors,
  };
}

/**
 * Run the sweep and print a compact digest.
 *
 * Exists because the endpoint is not always reachable — the deploy log always
 * is. One line per lead so it can be read straight out of Railway.
 */
async function logInterestedSweep({ hours = 24 } = {}) {
  try {
    const r = await sweepInterested({ hours });
    console.log('[Sweep] Interested replies', {
      hours: r.hours,
      clients: r.clientsScanned,
      scanned: r.repliesScanned,
      interested: r.interestedFound,
      likelyBooked: r.likelyBooked.length,
      noEvidence: r.interestedNoBookingEvidence.length,
    });
    for (const b of r.likelyBooked) {
      console.log(`[Sweep] BOOKED? ${b.confidence} | ${b.client} | ${b.lead} <${b.email || 'no email'}> | ${b.smartleadCategory || '?'} | ${b.signals.join(',')}`);
    }
    for (const n of r.interestedNoBookingEvidence) {
      console.log(`[Sweep] OPEN     | ${n.client} | ${n.lead} <${n.email || 'no email'}> | ${n.smartleadCategory || '?'} | ${String(n.reply).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    for (const e of r.errors) console.warn('[Sweep] error', e);
    return r;
  } catch (err) {
    console.error('[Sweep] Interested sweep failed', { err: err.message });
    return null;
  }
}

module.exports = { sweepInterested, logInterestedSweep };
