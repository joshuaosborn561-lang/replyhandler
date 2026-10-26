/**
 * Inbound canon. CI's Invariant guards job runs this file. A failure blocks merge.
 *
 * docs/INBOUND_CANON.md is the rule. These tests are the enforcement:
 * full text, one email = one card = at most one send, and a genuinely new
 * reply always posts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { acceptInboundDelivery } = require('../src/services/smartlead-inbound');
const {
  claimOutboundSend,
  inboundPrefix,
  normalizeInboundText,
  outboundSendBlockedReason,
  PREFIX_LEN,
} = require('../src/services/reply-dedupe');
const { SMARTLEAD_NON_REPLY_EVENTS } = require('../src/utils/smartlead-webhook-helpers');
const { buildDraftApprovalCard } = require('../src/services/slack');
const { threadAndLatestForDraft } = require('../src/services/claude-reply-draft');
const { notifyPortalPositiveReply } = require('../src/services/portal-positive-reply');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CLIENT = '11111111-1111-4111-8111-111111111111';

const CANON_RULES = [
  "1. FULL TEXT: every Slack card, stored inbound row and drafter input shows the prospect's full email. No silent truncation.",
  '2. ONE EMAIL = ONE CARD = AT MOST ONE SEND: a single inbound email must never produce two cards, two portal forwards or two sends, however many times or ways it reaches us (Smartlead reply webhook, Smartlead category-changed webhook, the SmartLead inbox polling backstop, HeyReach, retries).',
  '3. NEVER DROP A REAL REPLY: a genuinely new reply from the same person must always post. No time-window dedupe and no stats-id/campaign keyed dedupe (both were tried and removed on purpose).',
];

function legacyNorm(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function samePerson(row, lid, email) {
  if (lid && String(row.lead_id || '') === String(lid)) return true;
  if (email && String(row.lead_email || '').toLowerCase() === String(email).toLowerCase()) return true;
  return false;
}

function textAllowed(storedId, incomingId) {
  const incoming = String(incomingId || '').trim().toLowerCase();
  const stored = String(storedId || '').trim().toLowerCase();
  if (!incoming || !stored) return true;
  return stored === incoming;
}

function storedMatchesText(storedText, prefix, fullNorm) {
  const storedPrefix = inboundPrefix(storedText);
  const storedFull = normalizeInboundText(storedText);
  if (prefix && storedPrefix === prefix) return true;
  return fullNorm.length >= 40
    && storedFull.length >= 40
    && (storedFull.startsWith(fullNorm) || fullNorm.startsWith(storedFull));
}

function project(row) {
  return {
    id: row.id,
    status: row.status,
    inbound_message: row.inbound_message,
    inbound_message_id: row.inbound_message_id,
    classification: row.classification,
    slack_message_ts: row.slack_message_ts,
    client_id: row.client_id,
    platform: row.platform,
    lead_id: row.lead_id,
    lead_email: row.lead_email,
    lead_name: row.lead_name,
    campaign_id: row.campaign_id,
    draft_reply: row.draft_reply,
    sent_reply: row.sent_reply,
    created_at: row.created_at,
    updated_at: row.updated_at,
    follow_up_step: row.follow_up_step,
    follow_up_source_id: row.follow_up_source_id,
    follow_up_id: row.follow_up_id,
  };
}

function createMemoryDb() {
  const rows = [];
  let n = 0;

  async function query(sql, params = []) {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [] };
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [{ pg_advisory_xact_lock: '' }] };

    if (/fuller-inbound/.test(s)) {
      const [text, mid, id] = params;
      const row = rows.find((r) => r.id === id);
      if (!row) return { rows: [] };
      row.inbound_message = text;
      if (mid && !row.inbound_message_id) row.inbound_message_id = mid;
      row.updated_at = new Date().toISOString();
      return { rows: [{ ...row }] };
    }

    if (/inbound-category/.test(s)) {
      const [classification, id] = params;
      const row = rows.find((r) => r.id === id);
      if (!row) return { rows: [] };
      row.classification = classification;
      row.updated_at = new Date().toISOString();
      return { rows: [{ ...row }] };
    }

    if (/INSERT INTO pending_replies/i.test(s)) {
      n += 1;
      const row = {
        id: `row-${n}`,
        client_id: params[0],
        platform: params[1],
        campaign_id: params[2],
        campaign_name: params[3],
        lead_id: params[4],
        lead_name: params[5],
        lead_email: params[6],
        inbound_message: params[7],
        thread_context: params[8],
        classification: params[9],
        draft_reply: params[10],
        status: params[11],
        smartlead_email_stats_id: params[12],
        inbound_message_id: params[13] || null,
        slack_message_ts: null,
        sent_reply: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        follow_up_step: null,
        follow_up_source_id: null,
        follow_up_id: null,
      };
      rows.push(row);
      return { rows: [{ ...row }] };
    }

    if (/SET status = 'sending'/.test(s)) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) {
        row.status = 'sending';
        row.updated_at = new Date().toISOString();
      }
      return { rows: row ? [{ ...row }] : [] };
    }

    if (/SET status = 'skipped'/.test(s)) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) {
        row.status = 'skipped';
        row.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    if (/inbound-message-id-match/.test(s)) {
      const [clientId, platform, mid, lid, email] = params;
      const hit = rows
        .filter((r) => r.client_id === clientId
          && r.platform === platform
          && String(r.classification || '') !== 'FOLLOW_UP'
          && String(r.inbound_message_id || '').toLowerCase() === String(mid || '').toLowerCase()
          && samePerson(r, lid, email))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      return { rows: hit ? [project(hit)] : [] };
    }

    if (/regexp_replace/.test(s) && /pending_replies/.test(s)) {
      const [clientId, platform, prefix, fullNorm, lid, email, messageId] = params;
      const hit = rows
        .filter((r) => r.client_id === clientId
          && r.platform === platform
          && String(r.classification || '') !== 'FOLLOW_UP'
          && samePerson(r, lid, email)
          && textAllowed(r.inbound_message_id, messageId)
          && storedMatchesText(r.inbound_message, prefix, fullNorm))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      return { rows: hit ? [project(hit)] : [] };
    }

    if (/status IN \('sending', 'sent', 'approved'\)/.test(s)) {
      const [clientId, platform, exceptId, lid, email] = params;
      const hits = rows.filter((r) => r.client_id === clientId
        && r.platform === platform
        && r.id !== exceptId
        && ['sending', 'sent', 'approved'].includes(r.status)
        && samePerson(r, lid, email));
      return { rows: hits.map((r) => ({ ...r })) };
    }

    if (/JOIN pending_replies other/.test(s)) {
      const me = rows.find((r) => r.id === params[0]);
      if (!me || !me.inbound_message_id) return { rows: [] };
      const other = rows.find((r) => r.id !== me.id
        && r.client_id === me.client_id
        && String(r.classification || '') !== 'FOLLOW_UP'
        && String(r.inbound_message_id || '').toLowerCase() === String(me.inbound_message_id).toLowerCase()
        && r.slack_message_ts
        && !String(r.slack_message_ts).startsWith('claiming:'));
      return { rows: other ? [{ ok: 1 }] : [] };
    }

    if (/SELECT created_at FROM pending_replies/.test(s)) {
      const row = rows.find((r) => r.id === params[0]);
      return { rows: row ? [{ created_at: row.created_at }] : [] };
    }

    if (/SELECT \* FROM pending_replies WHERE id/i.test(s)) {
      const row = rows.find((r) => r.id === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    throw new Error(`unhandled sql: ${s.slice(0, 280)}`);
  }

  return {
    rows,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

function henryBodies() {
  const tailHtml = 'Best, Henry Witt / Vice President of Operations. Thursday afternoon works.';
  const tailPlain = '> Best, Henry Witt / Vice President [mwitt@hmwitt.com]';
  let head = 'Appreciate the note on the owner tickets and the timing for a walkthrough';
  while (head.length < 95) head += 'x';
  head = head.slice(0, 95);
  if (/\s$/.test(head)) head = `${head.slice(0, 94)}x`;
  head += ' ';
  assert.equal(head.length, 96);
  assert.equal(head[95], ' ');
  assert.equal(/\s{2}/.test(head), false);
  const html = `${head}${tailHtml}`;
  const plain = `${head}\n${tailPlain}`;
  const at = firstDiff(legacyNorm(html), legacyNorm(plain));
  assert.equal(at, 96, 'character 97 is where the HTML reply and the plain category copy diverge');
  assert.ok(at < PREFIX_LEN);
  assert.notEqual(legacyNorm(html).slice(0, PREFIX_LEN), legacyNorm(plain).slice(0, PREFIX_LEN));
  assert.equal(inboundPrefix(html), inboundPrefix(plain));
  return { html, plain };
}

const HENRY_MESSAGE_ID = '<CH2PR18MB3160.hwitt.oct26@prod.outlook.com>';

function henryReplyPayload(html) {
  return {
    event_type: 'EMAIL_REPLY',
    email_campaign_id: 1019,
    email_campaign_name: 'SG Subs Owners Tickets 1019',
    email_lead_id: 55501,
    lead_email: 'hwitt@hmwitt.com',
    lead_first_name: 'Henry',
    lead_last_name: 'Witt',
    stats_id: 'shared-sent-stats',
    reply_message: {
      html: `<html><body><p>${html}</p></body></html>`,
      message_id: HENRY_MESSAGE_ID,
    },
  };
}

function henryCategoryPayload(plain) {
  return {
    event_type: 'LEAD_CATEGORY_UPDATED',
    email_campaign_id: 1019,
    email_campaign_name: 'SG Subs Owners Tickets 1019',
    email_lead_id: 55501,
    stats_id: 'shared-sent-stats',
    lead_category: { new_id: 1, new_name: 'Interested', old_id: null, old_name: null },
    lead_data: { id: 55501, email: 'hwitt@hmwitt.com', first_name: 'Henry', last_name: 'Witt' },
    history: [
      {
        type: 'SENT',
        time: '2026-10-25T15:00:00.000Z',
        email_body: 'Earlier note about owner tickets.',
        message_id: '<sent-1019@salesglider.com>',
      },
      {
        type: 'REPLY',
        time: '2026-10-26T18:35:00.000Z',
        from: 'hwitt@hmwitt.com',
        email_body: plain,
        message_id: HENRY_MESSAGE_ID,
      },
    ],
  };
}

function billPair() {
  const intro = 'Adding my Office manager Rebecca ';
  const tailEntity = 'Bill Hall &#8211; Project Executive';
  const tailHyphen = 'Bill Hall - Project Executive';
  for (let n = 0; n < 200; n += 1) {
    const filler = 'n'.repeat(n);
    const entity = `${intro}${filler} ${tailEntity}`;
    const hyphen = `${intro}${filler} ${tailHyphen}`;
    if (firstDiff(legacyNorm(entity), legacyNorm(hyphen)) === 112) return { entity, hyphen };
  }
  throw new Error('could not place the Bill Hall dash at character 112');
}

const SCOTT_FULL = [
  'Josh,',
  '',
  'Thanks for reaching out. I am the founder at TechEvo and we help mid-market operators modernize their field service stack.',
  '',
  'A few things I would want to cover before I put anything on the calendar:',
  '1. Who you have already booked meetings with in home services, and what the show rate looked like.',
  '2. Whether the guarantee is meetings held or meetings booked, and what happens in month two if we are behind.',
  '3. How you handle a technical buyer who wants to see the integration path before a call with me.',
  '',
  'We are not looking for a free pilot. If the fit is real I will loop in our ops lead and we can talk through a ninety-day plan, the handoff, and what you need from us on the first week.',
  '',
  'If that is a fit, I can do a short call next week. I am in Austin and usually free Tuesday or Wednesday afternoon.',
  '',
  'Scott Payea',
  'TechEvo',
].join('\n');

function scottHtml(body) {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<html><body><div>${escaped}</div></body></html>`;
}

function sectionText(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === 'section' && b.text && b.text.text)
    .map((b) => b.text.text)
    .join('\n');
}

test('Henry Witt reply + category webhook in both orders = 1 card, 1 forward', async () => {
  assert.equal(SMARTLEAD_NON_REPLY_EVENTS.has('LEAD_CATEGORY_UPDATED'), false);
  const { html, plain } = henryBodies();
  const reply = henryReplyPayload(html);
  const category = henryCategoryPayload(plain);

  for (const order of [['reply', 'category'], ['category', 'reply']]) {
    const db = createMemoryDb();
    const results = [];
    for (const kind of order) {
      results.push(await acceptInboundDelivery({
        clientId: CLIENT,
        payload: kind === 'reply' ? reply : category,
        db,
      }));
    }
    const label = order.join(' then ');
    assert.equal(results.some((r) => r.reason === 'incomplete'), false, label);
    assert.equal(db.rows.length, 1, label);
    assert.equal(results.filter((r) => r.postCard).length, 1, label);
    assert.equal(results.filter((r) => r.forward).length, 1, label);
    assert.equal(results.filter((r) => r.duplicate).length, 1, label);
    assert.match(db.rows[0].inbound_message, /Thursday afternoon works/);
    assert.equal(db.rows[0].classification, 'INTERESTED');
    assert.equal(db.rows[0].inbound_message_id, HENRY_MESSAGE_ID.toLowerCase());
    assert.equal(db.rows[0].smartlead_email_stats_id, 'shared-sent-stats');
  }

  const db = createMemoryDb();
  await acceptInboundDelivery({ clientId: CLIENT, payload: reply, db });
  db.rows[0].slack_message_ts = '1710000000.000100';
  db.rows.push({
    ...db.rows[0],
    id: 'row-dup-card',
    slack_message_ts: null,
    status: 'pending',
  });
  const prevUrl = process.env.PORTAL_URL;
  const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
  process.env.PORTAL_URL = 'https://portal.example.test';
  process.env.PORTAL_WEBHOOK_SECRET = 'canon-test-secret';
  try {
    const portal = await notifyPortalPositiveReply({
      classification: 'INTERESTED',
      replyId: 'row-dup-card',
      email: 'hwitt@hmwitt.com',
      clientId: CLIENT,
    }, {
      db,
      fetchFn() { throw new Error('portal fetch must not run for the duplicate'); },
    });
    assert.equal(portal.skipped, true);
    assert.equal(portal.reason, 'already_forwarded');
  } finally {
    if (prevUrl == null) delete process.env.PORTAL_URL;
    else process.env.PORTAL_URL = prevUrl;
    if (prevSecret == null) delete process.env.PORTAL_WEBHOOK_SECRET;
    else process.env.PORTAL_WEBHOOK_SECRET = prevSecret;
  }
});

test("Bill Hall &#8211; vs '-' webhook + poller = 1 card", async () => {
  const { entity, hyphen } = billPair();
  assert.equal(firstDiff(legacyNorm(entity), legacyNorm(hyphen)), 112);
  assert.equal(inboundPrefix(entity), inboundPrefix(hyphen));
  const db = createMemoryDb();
  const webhook = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 8801,
      email_campaign_name: 'EMCOR',
      email_lead_id: 4242,
      lead_email: 'bill.hall@emcor.com',
      lead_first_name: 'Bill',
      lead_last_name: 'Hall',
      stats_id: 'stats-bill-hall',
      reply_message: { text: hyphen },
    },
    db,
  });
  const poller = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 8801,
      email_campaign_name: 'EMCOR',
      email_lead_id: 4242,
      lead_email: 'bill.hall@emcor.com',
      lead_first_name: 'Bill',
      lead_last_name: 'Hall',
      stats_id: 'stats-bill-hall',
      email_history: [
        {
          type: 'REPLY',
          time: '2026-10-22T18:52:00.000Z',
          from: 'bill.hall@emcor.com',
          email_body: entity,
        },
      ],
    },
    db,
  });
  assert.equal(webhook.postCard, true);
  assert.equal(poller.duplicate, true);
  assert.equal(poller.postCard, false);
  assert.equal(poller.forward, false);
  assert.equal(db.rows.length, 1);
});

test('Scott Payea short preview text + full HTML = 1 card with the full text', async () => {
  let cutAt = 250;
  while (cutAt < SCOTT_FULL.length && /\s/.test(SCOTT_FULL[cutAt - 1])) cutAt += 1;
  const preview = SCOTT_FULL.slice(0, cutAt);
  assert.ok(preview.length < SCOTT_FULL.length);
  const messageId = '<scott.payea.oct26@techevo.com>';
  const base = {
    email_campaign_id: 7701,
    email_campaign_name: 'TechEvo | Intro',
    email_lead_id: 9090,
    lead_email: 'scott@techevo.com',
    lead_first_name: 'Scott',
    lead_last_name: 'Payea',
  };
  const db = createMemoryDb();
  const first = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      ...base,
      event_type: 'EMAIL_REPLY',
      reply_message: { text: preview, message_id: messageId },
    },
    db,
  });
  const second = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      ...base,
      event_type: 'EMAIL_REPLY',
      reply_message: { text: preview, html: scottHtml(SCOTT_FULL), message_id: messageId },
    },
    db,
  });
  assert.equal(first.postCard, true);
  assert.equal(second.postCard, false);
  assert.equal(second.forward, false);
  assert.equal(db.rows.length, 1);
  assert.match(db.rows[0].inbound_message, /Scott Payea/);
  assert.match(db.rows[0].inbound_message, /I am in Austin/);
  assert.ok(db.rows[0].inbound_message.length > preview.length);
});

test('webhook + poller backstop for the same email = 1 card', async () => {
  const messageId = '<poller-backstop.oct26@example.com>';
  const full = 'Josh, yes let us look at this next week. I can do Tuesday after 2. Bring the one-pager and we can decide on the call.';
  const quoted = `${full}\n> Sent from my iPhone [link] <mailto:alex@example.com>`;
  const db = createMemoryDb();
  const webhook = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 6601,
      email_campaign_name: 'Backstop',
      email_lead_id: 3030,
      lead_email: 'alex@example.com',
      lead_first_name: 'Alex',
      reply_message: { text: full, message_id: messageId },
    },
    db,
  });
  const poller = await acceptInboundDelivery({
    clientId: CLIENT,
    messageId,
    inboundMessage: quoted,
    payload: {
      event_type: 'EMAIL_REPLY',
      campaign_id: 6601,
      campaign_name: 'Backstop',
      lead_id: 3030,
      lead_email: 'alex@example.com',
      email_history: [
        {
          type: 'REPLY',
          time: '2026-10-26T19:00:00.000Z',
          from: 'alex@example.com',
          email_body: quoted,
          message_id: messageId,
        },
      ],
    },
    db,
  });
  assert.equal(webhook.postCard, true);
  assert.equal(webhook.forward, true);
  assert.equal(poller.duplicate, true);
  assert.equal(poller.postCard, false);
  assert.equal(poller.forward, false);
  assert.equal(db.rows.length, 1);
  assert.match(db.rows[0].inbound_message, /Tuesday after 2/);
});

test('the same person sending a second, genuinely different reply minutes later = 2 cards', async () => {
  const dedupe = read('src/services/reply-dedupe.js');
  const recorded = dedupe.slice(
    dedupe.indexOf('async function inboundAlreadyRecorded'),
    dedupe.indexOf('async function alreadyPostedToSlack')
  );
  assert.doesNotMatch(recorded, /interval '/);
  assert.doesNotMatch(dedupe, /smartlead_email_stats_id/);

  const db = createMemoryDb();
  const first = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 1019,
      email_campaign_name: 'SG Subs Owners Tickets 1019',
      email_lead_id: 55501,
      lead_email: 'hwitt@hmwitt.com',
      stats_id: 'shared-sent-stats',
      reply_message: {
        text: 'Yes, Tuesday at 2pm works for a walkthrough at the yard.',
        message_id: '<henry-tuesday@prod.outlook.com>',
      },
    },
    db,
  });
  db.rows[0].created_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const second = await acceptInboundDelivery({
    clientId: CLIENT,
    payload: {
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 1019,
      email_campaign_name: 'SG Subs Owners Tickets 1019',
      email_lead_id: 55501,
      lead_email: 'hwitt@hmwitt.com',
      stats_id: 'shared-sent-stats',
      reply_message: {
        text: 'Actually hold off. Wednesday is better, and please bring the one-pager.',
        message_id: '<henry-wednesday@prod.outlook.com>',
      },
    },
    db,
  });
  assert.equal(first.postCard, true);
  assert.equal(second.postCard, true);
  assert.equal(second.forward, true);
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].smartlead_email_stats_id, db.rows[1].smartlead_email_stats_id);
  assert.notEqual(db.rows[0].inbound_message_id, db.rows[1].inbound_message_id);
});

test("the same person sending an identical short text ('Thanks') in two separate emails with different Message-IDs = 2 cards", async () => {
  const db = createMemoryDb();
  const ids = ['<thanks-one@hmwitt.com>', '<thanks-two@hmwitt.com>'];
  const results = [];
  for (const messageId of ids) {
    results.push(await acceptInboundDelivery({
      clientId: CLIENT,
      payload: {
        event_type: 'EMAIL_REPLY',
        email_campaign_id: 1019,
        email_campaign_name: 'SG Subs Owners Tickets 1019',
        email_lead_id: 55501,
        lead_email: 'hwitt@hmwitt.com',
        reply_message: { text: 'Thanks', message_id: messageId },
      },
      db,
    }));
  }
  assert.equal(results[0].postCard, true);
  assert.equal(results[1].postCard, true);
  assert.equal(results[1].duplicate, false);
  assert.equal(db.rows.length, 2);
  assert.equal(db.rows[0].inbound_message, 'Thanks');
  assert.equal(db.rows[1].inbound_message, 'Thanks');
  assert.notEqual(db.rows[0].inbound_message_id, db.rows[1].inbound_message_id);

  assert.equal(outboundSendBlockedReason({
    candidate: {
      classification: 'INTERESTED',
      replyText: 'Sounds good, sending times.',
      inboundMessage: 'Thanks',
      inboundMessageId: ids[1],
    },
    existing: {
      status: 'sent',
      classification: 'INTERESTED',
      sentReply: 'A different note from the first Thanks.',
      inboundMessage: 'Thanks',
      inboundMessageId: ids[0],
    },
  }), null);
});

test('a long 6000+ char reply shows in full', () => {
  const long = `Opening line about the integration path.\n\n${'We need the full scope of the home-service rollout before we commit to a calendar hold. '.repeat(90)}`;
  assert.ok(long.length > 6000, `long reply is ${long.length} chars`);
  const card = buildDraftApprovalCard({
    replyId: 'long-canon',
    leadName: 'Scott Payea',
    leadEmail: 'scott@techevo.com',
    platform: 'smartlead',
    classification: 'INTERESTED',
    draft: 'Hey Scott, thanks for laying that out.',
    inboundMessage: long,
    lastOutboundMessage: 'Wanted to send a note.',
    campaignDisplay: 'TechEvo | Intro',
  });
  const shown = [
    sectionText(card.blocks),
    sectionText(card.overflowBlocks),
    sectionText(card.overflowThread),
  ].join('\n');
  assert.match(shown, /Opening line about the integration path/);
  assert.match(shown, /calendar hold\./);
  assert.doesNotMatch(shown, /_\(truncated\)_/);
  for (const block of [...(card.blocks || []), ...(card.overflowBlocks || []), ...(card.overflowThread || [])]) {
    if (block.text && block.text.text) assert.ok(block.text.text.length <= 3000);
  }
  const stored = normalizeInboundText(long, { forStorage: true });
  assert.ok(stored.length > 6000);
  assert.match(stored, /Opening line about the integration path/);
  assert.match(stored, /calendar hold\./);
});

test('the drafter input contains the full latest reply', () => {
  const long = `Opening line about the integration path.\n\n${'We need the full scope of the home-service rollout before we commit to a calendar hold. '.repeat(90)}`;
  assert.ok(long.length > 6000);
  const input = threadAndLatestForDraft([{ role: 'us', message: 'Earlier outbound.' }], long);
  assert.equal(input.latest, long.trim());
  assert.match(input.latest, /calendar hold\./);

  const src = read('src/services/claude-reply-draft.js');
  const start = src.indexOf("'<latest_prospect_reply>'");
  const end = src.indexOf("'</latest_prospect_reply>'");
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /draftedInput\.latest/);
  assert.doesNotMatch(block, /\.slice\(/);
  assert.doesNotMatch(block, /substring\(/);
});

test('approving one card for an email whose duplicate card somehow exists cannot send twice', async () => {
  const db = createMemoryDb();
  const messageId = '<duplicate-card-send@prod.outlook.com>';
  const inbound = 'Thursday afternoon works. Happy to walk through the ticket program.';
  db.rows.push({
    id: 'card-a',
    client_id: CLIENT,
    platform: 'smartlead',
    campaign_id: '1019',
    lead_id: '55501',
    lead_email: 'hwitt@hmwitt.com',
    lead_name: 'Henry Witt',
    inbound_message: inbound,
    inbound_message_id: messageId.toLowerCase(),
    classification: 'INTERESTED',
    draft_reply: 'Hello from card A',
    sent_reply: 'Hello from card A',
    status: 'sent',
    slack_message_ts: '1710000000.000200',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    follow_up_step: null,
    follow_up_source_id: null,
    follow_up_id: null,
  });
  db.rows.push({
    id: 'card-b',
    client_id: CLIENT,
    platform: 'smartlead',
    campaign_id: '1019',
    lead_id: '55501',
    lead_email: 'hwitt@hmwitt.com',
    lead_name: 'Henry Witt',
    inbound_message: inbound,
    inbound_message_id: messageId.toLowerCase(),
    classification: 'INTERESTED',
    draft_reply: 'A completely different draft',
    sent_reply: null,
    status: 'pending',
    slack_message_ts: '1710000000.000300',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    follow_up_step: null,
    follow_up_source_id: null,
    follow_up_id: null,
  });

  const claimed = await claimOutboundSend({
    replyId: 'card-b',
    replyText: 'A completely different draft',
  }, db);
  assert.equal(claimed.ok, false);
  assert.equal(claimed.reason, 'same_inbound');
  assert.equal(db.rows.find((r) => r.id === 'card-b').status, 'skipped');
  assert.equal(db.rows.find((r) => r.id === 'card-a').status, 'sent');
});

test('the canon doc, the decision, and the Invariant guards job name this suite', () => {
  const doc = read('docs/INBOUND_CANON.md');
  for (const rule of CANON_RULES) assert.ok(doc.includes(rule), rule);

  const decisions = read('DECISIONS.md');
  for (const rule of CANON_RULES) assert.ok(decisions.includes(rule), rule);
  assert.match(decisions, /test\/inbound-canon\.test\.js/);

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /name: Invariant guards/);
  assert.match(ci, /test\/inbound-canon\.test\.js/);
  assert.match(ci, /docs\/INBOUND_CANON\.md/);
  assert.match(ci, /npm test/);

  const startup = read('scripts/run-migrations.js');
  const list = startup.slice(
    startup.indexOf('const MIGRATION_FILES'),
    startup.indexOf('async function clientsTableExists')
  );
  assert.ok(
    list.indexOf('042_smartlead_campaign_routes.sql') < list.indexOf('043_inbound_message_id.sql'),
    '043 must run after 042'
  );
  const sql = read('migrations/043_inbound_message_id.sql');
  assert.match(sql, /inbound_message_id/);
  assert.match(sql, /idx_pending_replies_inbound_message_id/);
  assert.match(sql, /inbound_forwards_message_once/);

  const dedupe = read('src/services/reply-dedupe.js');
  const claim = dedupe.slice(
    dedupe.indexOf('async function claimNewInbound'),
    dedupe.indexOf('function sameOutboundText')
  );
  assert.match(claim, /pg_advisory_xact_lock/);
  assert.match(claim, /Message-ID first/);
  assert.ok(
    claim.indexOf('inboundAlreadyRecorded(conn') < claim.indexOf('insertFn(conn)'),
    'the message-id check runs inside the lock before insert'
  );
  const recorded = dedupe.slice(
    dedupe.indexOf('async function inboundAlreadyRecorded'),
    dedupe.indexOf('async function alreadyPostedToSlack')
  );
  assert.ok(recorded.indexOf('inbound-message-id-match') < recorded.indexOf('sameReplySql'));
  assert.doesNotMatch(recorded, /interval '/);
  assert.doesNotMatch(dedupe, /smartlead_email_stats_id/);

  const webhook = read('src/routes/webhooks.js');
  const dupAt = webhook.indexOf("reason: 'duplicate_db'");
  const immediateAt = webhook.indexOf('setImmediate', dupAt);
  assert.ok(dupAt > 0 && immediateAt > dupAt, 'a duplicate returns before the async card and forward');

  const poller = read('src/services/smartlead-poller.js');
  const pollerClaim = poller.slice(
    poller.indexOf('const claimed = await claimNewInbound'),
    poller.indexOf('if (claimed.duplicate)')
  );
  assert.match(pollerClaim, /messageId/);
  assert.match(pollerClaim, /inbound_message_id/);
});
