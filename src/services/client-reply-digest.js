'use strict';

/**
 * Client positive-reply roll-up (Josh, Oct 29 2026).
 *
 * The "Prospect reply: ..." email used to go to the client the moment we sent each reply. It now
 * goes out once a day: ONE email per client at 4:00pm CT on weekdays, listing the positive
 * prospects we actually answered. Weekend replies ride in Monday's email, and a day with nothing
 * to report sends nothing.
 *
 *   - Only INTERESTED / MEETING_PROPOSED replies we SENT a reply to (not follow-up nudges, not
 *     replies nobody answered). Same positive set the client portal uses.
 *   - To = the client's notify_emails list; CC = Cayden (FYI_CC_EMAILS) and Josh.
 *     cc_emails, cc_email, contact_email, and the round-robin pool are not copied.
 *     Nobody is listed twice.
 *   - Queue = pending_replies.client_digest_status ('pending' when queued at send time).
 *   - PROSPECT_REPLY_NOTIFY_MODE: rollup (default) | instant (the old per-send email) | off.
 */

const db = require('../db');
const gmail = require('./gmail-send');
const { notifyEmails, parseEmailList } = require('./client-cc');
const { escapeHtml, plainFromHtmlish } = require('./client-notify-email');
const { fyiCcEmails, fyiReplyTo, mergeEmailLists } = require('../utils/fyi-notify');
const { stripQuoted } = require('./booked-brief-data');

const POSITIVE = new Set(['INTERESTED', 'MEETING_PROPOSED']);
const DEFAULT_JOSH = 'joshua@salesglidergrowth.com';
const TZ = 'America/Chicago';
const DIGEST_TIME_LABEL = '4:00 PM CT';
const STALE_CLAIM_MIN = 20;
const NOTES_LINE = 'If you have any notes, just hit reply all. Our operations team sees it.';

function clientNotifyMode(env = process.env) {
  const v = String(env.PROSPECT_REPLY_NOTIFY_MODE || '').trim().toLowerCase();
  return v === 'instant' || v === 'off' ? v : 'rollup';
}

/** A reply belongs in the roll-up when it is a positive prospect reply (never a follow-up nudge). */
function isDigestEligible(reply) {
  return Boolean(reply)
    && reply.platform === 'smartlead'
    && POSITIVE.has(String(reply.classification || '').toUpperCase())
    && !reply.follow_up_id;
}

/** Who gets a client's roll-up. Josh and Cayden are copied; a notify address is never duplicated. */
function digestRecipients(client, env = process.env) {
  const josh = parseEmailList(String(env.CLIENT_DIGEST_JOSH_EMAIL || DEFAULT_JOSH));
  const cc = mergeEmailLists(fyiCcEmails(env), josh);
  const list = notifyEmails(client).filter((e) => !cc.includes(e));
  return { to: list, cc };
}

/** Mark a just-sent reply as waiting for the next roll-up. Never throws. */
async function queueForDigest(replyId, { query = db.query.bind(db) } = {}) {
  try {
    const { rowCount } = await query(
      `UPDATE pending_replies
          SET client_digest_status = 'pending', client_digest_queued_at = now()
        WHERE id = $1 AND client_digest_status IS NULL`,
      [replyId],
    );
    return rowCount > 0;
  } catch (err) {
    console.error('[ClientDigest] could not queue reply', { replyId, err: err.message });
    return false;
  }
}

function ct(iso, opts) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(d);
}

function whenLabel(iso) {
  const day = ct(iso, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = ct(iso, { hour: 'numeric', minute: '2-digit' });
  return day && time ? `${day}, ${time} CT` : '';
}

function clean(text, max = 1500) {
  return stripQuoted(plainFromHtmlish(String(text || ''))).slice(0, max);
}

function leadKey(r) {
  return String(r.lead_email || '').trim().toLowerCase() || `lead:${r.lead_id || r.id}`;
}

/** One entry per prospect, exchanges oldest first. */
function groupByLead(rows) {
  const map = new Map();
  for (const r of [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    const k = leadKey(r);
    if (!map.has(k)) map.set(k, { rows: [] });
    map.get(k).rows.push(r);
  }
  return [...map.values()].map(({ rows: rs }) => {
    const last = rs[rs.length - 1];
    return {
      name: String(last.lead_full_name || last.lead_name || '').trim(),
      title: String(last.lead_title || '').trim(),
      company: String(last.lead_company || '').trim(),
      email: String(last.lead_email || '').trim(),
      phone: String(last.lead_phone || '').trim(),
      linkedin: /^https?:\/\//i.test(last.linkedin_url || '') ? String(last.linkedin_url).trim() : '',
      campaign: String(last.campaign_name || '').trim(),
      exchanges: rs.map((r) => ({
        theirAt: whenLabel(r.created_at),
        their: clean(r.inbound_message),
        ourAt: whenLabel(r.updated_at),
        ours: clean(r.sent_reply),
        classification: String(r.classification || '').toUpperCase(),
      })),
    };
  }).sort((a, b) => (a.name || a.company).localeCompare(b.name || b.company));
}

function dayLabel(now) {
  return ct(now, { weekday: 'long', month: 'short', day: 'numeric' });
}

function buildDigestEmail({ clientName, leads, now = new Date() }) {
  const n = leads.length;
  const subject = `Positive replies: ${n} ${n === 1 ? 'prospect' : 'prospects'} \u00b7 ${clientName} \u00b7 ${ct(now, { month: 'short', day: 'numeric' })}`;
  const opener = `FYI, here ${n === 1 ? 'is the positive reply' : 'are the positive replies'} we answered for ${clientName} since the last roll-up (${dayLabel(now)}): ${n} ${n === 1 ? 'prospect' : 'prospects'}.`;
  const field = (label, val) => (val ? `<tr><td style="padding:2px 12px 2px 0;color:#666;white-space:nowrap;">${label}</td><td style="padding:2px 0;">${val}</td></tr>` : '');
  const cards = leads.map((l) => {
    const head = [l.name || l.company || 'Prospect', l.title, l.name && l.company ? l.company : ''].filter(Boolean).join(' \u00b7 ');
    const rows = [
      field('Email', escapeHtml(l.email)),
      field('Cell', escapeHtml(l.phone)),
      field('LinkedIn', l.linkedin ? `<a href="${escapeHtml(l.linkedin)}">${escapeHtml(l.linkedin)}</a>` : ''),
    ].join('');
    const ex = l.exchanges.map((e) => `
      <div style="border-left:3px solid #f59e0b;background:#fffbeb;padding:8px 12px;margin:8px 0 0;border-radius:4px;">
        <div style="font-size:12px;color:#666;margin:0 0 4px;">Their reply${e.theirAt ? ` \u00b7 ${escapeHtml(e.theirAt)}` : ''}</div>
        <div style="white-space:pre-wrap;">${escapeHtml(e.their)}</div>
      </div>
      <div style="border-left:3px solid #d1d5db;background:#f9fafb;padding:8px 12px;margin:6px 0 0;border-radius:4px;">
        <div style="font-size:12px;color:#666;margin:0 0 4px;">Our reply${e.ourAt ? ` \u00b7 ${escapeHtml(e.ourAt)}` : ''}</div>
        <div style="white-space:pre-wrap;">${escapeHtml(e.ours)}</div>
      </div>`).join('');
    return `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;margin:0 0 14px;background:#fff;">
      <div style="font-weight:600;margin:0 0 6px;">${escapeHtml(head)}</div>
      <table style="border-collapse:collapse;font-size:14px;">${rows}</table>${ex}
    </div>`;
  }).join('');
  const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.45;">
  <p>${escapeHtml(opener)}</p>
  <p>${escapeHtml(NOTES_LINE)}</p>
  ${cards}
  <p style="margin:20px 0 0;color:#666;font-size:12px;">Sent automatically once a day at ${DIGEST_TIME_LABEL}, weekdays. Nothing is sent on a day with no positive replies.</p>
</div>`;
  const textBody = [
    opener, NOTES_LINE, '',
    ...leads.flatMap((l) => [
      [l.name || l.company || 'Prospect', l.title, l.name && l.company ? l.company : ''].filter(Boolean).join(' - '),
      ...(l.email ? [`Email: ${l.email}`] : []),
      ...(l.phone ? [`Cell: ${l.phone}`] : []),
      ...(l.linkedin ? [`LinkedIn: ${l.linkedin}`] : []),
      ...l.exchanges.flatMap((e) => ['', `Their reply${e.theirAt ? ` (${e.theirAt})` : ''}:`, e.their, '', `Our reply${e.ourAt ? ` (${e.ourAt})` : ''}:`, e.ours]),
      '', '---', '',
    ]),
    `Sent automatically once a day at ${DIGEST_TIME_LABEL}, weekdays.`,
  ].join('\n').trimEnd();
  return { subject, htmlBody, textBody };
}

/**
 * Send the roll-up. One email per client with at least one queued, sent reply. A failure for one client
 * puts its replies back in the queue (next run) and never blocks the others.
 */
async function runClientReplyDigest({
  now = new Date(),
  query = db.query.bind(db),
  send = (m) => gmail.sendMail(m),
  env = process.env,
} = {}) {
  const summary = { clients: 0, replies: 0, sent: 0, failed: 0, skipped: 0 };
  // A crashed run leaves rows 'sending'; give them back after a grace period.
  await query(
    `UPDATE pending_replies SET client_digest_status = 'pending', client_digest_claimed_at = NULL
      WHERE client_digest_status = 'sending'
        AND client_digest_claimed_at < now() - make_interval(mins => $1::int)`,
    [STALE_CLAIM_MIN],
  );
  const { rows } = await query(
    `UPDATE pending_replies SET client_digest_status = 'sending', client_digest_claimed_at = now()
      WHERE client_digest_status = 'pending' AND status = 'sent'
      RETURNING id, client_id, lead_id, lead_name, lead_full_name, lead_email, lead_phone, linkedin_url,
                lead_title, lead_company, campaign_name, inbound_message, sent_reply, classification,
                created_at, updated_at`,
  );
  if (!rows.length) return summary;
  summary.replies = rows.length;

  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id).push(r);
  }
  const release = (ids, status) => query(
    `UPDATE pending_replies SET client_digest_status = $2, client_digest_claimed_at = NULL,
            client_digest_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
      WHERE id = ANY($1::uuid[])`,
    [ids, status],
  );

  for (const [clientId, group] of byClient) {
    const ids = group.map((g) => g.id);
    summary.clients += 1;
    try {
      const { rows: [client] } = await query(
        'SELECT id, name, notify_emails, active FROM clients WHERE id = $1',
        [clientId],
      );
      if (!client || client.active === false) {
        await release(ids, 'sent');
        summary.skipped += 1;
        console.warn('[ClientDigest] inactive or missing client, roll-up skipped', { clientId, replies: ids.length });
        continue;
      }
      const { to, cc } = digestRecipients(client, env);
      if (!to.length) {
        // No client list (or the client is gone): nothing to send, and nothing to retry.
        await release(ids, 'sent');
        summary.skipped += 1;
        console.warn('[ClientDigest] no client recipients, roll-up skipped', { clientId, replies: ids.length });
        continue;
      }
      const leads = groupByLead(group);
      const { subject, htmlBody, textBody } = buildDigestEmail({ clientName: client.name, leads, now });
      await send({ to, cc, replyTo: fyiReplyTo(env), subject, htmlBody, textBody });
      await release(ids, 'sent');
      summary.sent += 1;
      console.log('[ClientDigest] roll-up sent', { client: client.name, prospects: leads.length, replies: ids.length, to: to.length });
    } catch (err) {
      summary.failed += 1;
      console.error('[ClientDigest] roll-up failed, will retry next run', { clientId, err: err.message });
      await release(ids, 'pending').catch((e) => console.error('[ClientDigest] could not re-queue', { err: e.message }));
    }
  }
  return summary;
}

module.exports = {
  clientNotifyMode, isDigestEligible, digestRecipients, queueForDigest, groupByLead, buildDigestEmail,
  runClientReplyDigest, POSITIVE, DIGEST_TIME_LABEL,
};
