/**
 * David Chapman, BCP, Nov 3 2026, 6:03 PM ET.
 *
 * The webhook posted one card. Ten seconds later the poller posted a second
 * card for the same email as SmartLead history rendered it: no `[image: Phoenix Logo]`,
 * and `678-208-6249(d)` with no space. Both were approved, so he was emailed twice.
 * Austin Neudecker hit the same split the same evening.
 *
 * The comparison key drops those placeholders and keeps letters and digits only.
 * The stored email and the card stay the full text. A different short reply
 * from the same lead is still its own card. No time window.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  inboundPrefix,
  normalizeInboundText,
  decodeInboundForStorage,
  claimNewInbound,
  MIN_CONTAINMENT_LEN,
} = require('../src/services/reply-dedupe');
const { canonicalInboundMessageId } = require('../src/utils/inbound-message-id');
const { listInboundReplies } = require('../src/utils/smartlead-webhook-helpers');

const ROOT = path.join(__dirname, '..');
const CLIENT = '8369d603-0000-4000-8000-000000000001';
const DAVID_ID = '<CAJPCoKPm=abc123@mail.gmail.com>';
const DAVID_CANON = canonicalInboundMessageId(DAVID_ID);
const SHARED = 'Thanks for reaching out about the Phoenix review today. ';
const WEBHOOK_BODY = `${SHARED}[image: Phoenix Logo] Call me at 678-208-6249 (d).`;
const POLLER_BODY = `${SHARED}Call me at 678-208-6249(d).`;

function legacyNorm(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function memoryDb() {
  const rows = [];
  let n = 0;

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

  function sameText(storedText, prefix, fullNorm) {
    const storedPrefix = inboundPrefix(storedText);
    const storedFull = normalizeInboundText(storedText);
    if (prefix && storedPrefix === prefix) return true;
    return fullNorm.length >= MIN_CONTAINMENT_LEN
      && storedFull.length >= MIN_CONTAINMENT_LEN
      && (storedFull.startsWith(fullNorm) || fullNorm.startsWith(storedFull));
  }

  async function query(sql, params = []) {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [] };
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [{}] };
    if (/fuller-inbound/.test(s)) return { rows: [] };

    if (/inbound-message-id-match/.test(s)) {
      const [clientId, platform, mid, lid, email] = params;
      const hit = rows.find((row) => row.client_id === clientId
        && row.platform === platform
        && String(row.classification || '') !== 'FOLLOW_UP'
        && String(row.inbound_message_id || '').toLowerCase() === String(mid || '').toLowerCase()
        && samePerson(row, lid, email));
      return { rows: hit ? [hit] : [] };
    }

    if (/regexp_replace/.test(s) && /pending_replies/.test(s)) {
      const [clientId, platform, prefix, fullNorm, lid, email, messageId] = params;
      const hit = rows.find((row) => row.client_id === clientId
        && row.platform === platform
        && String(row.classification || '') !== 'FOLLOW_UP'
        && samePerson(row, lid, email)
        && textAllowed(row.inbound_message_id, messageId)
        && sameText(row.inbound_message, prefix, fullNorm));
      return { rows: hit ? [hit] : [] };
    }

    throw new Error(`unexpected sql: ${s.slice(0, 140)}`);
  }

  return {
    rows,
    async connect() {
      return { query, release() {} };
    },
    insert(inboundMessage, messageId) {
      n += 1;
      const row = {
        id: `row-${n}`,
        client_id: CLIENT,
        platform: 'smartlead',
        lead_id: '4784068944',
        lead_email: 'david.chapman@phoenixpbm.com',
        inbound_message: inboundMessage,
        inbound_message_id: canonicalInboundMessageId(messageId) || null,
        classification: 'INTERESTED',
        slack_message_ts: null,
      };
      rows.push(row);
      return row;
    },
  };
}

async function claim(db, inboundMessage, messageId) {
  return claimNewInbound({
    clientId: CLIENT,
    platform: 'smartlead',
    leadId: '4784068944',
    leadEmail: 'David.Chapman@phoenixpbm.com',
    inboundMessage,
    messageId,
  }, async () => db.insert(decodeInboundForStorage(inboundMessage), messageId), db);
}

test('David Chapman webhook and poller bodies are one dedupe key, and the card keeps the image token', () => {
  const at = (() => {
    const a = legacyNorm(WEBHOOK_BODY);
    const b = legacyNorm(POLLER_BODY);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
    return n;
  })();
  assert.ok(at < 120, `the old prefix diverges at ${at}, inside the 120-char window`);
  assert.notEqual(legacyNorm(WEBHOOK_BODY).slice(0, 120), legacyNorm(POLLER_BODY).slice(0, 120));
  assert.equal(inboundPrefix(WEBHOOK_BODY), inboundPrefix(POLLER_BODY));
  assert.equal(normalizeInboundText(WEBHOOK_BODY), normalizeInboundText(POLLER_BODY));
  assert.match(normalizeInboundText(WEBHOOK_BODY), /6782086249d/);
  assert.doesNotMatch(normalizeInboundText(WEBHOOK_BODY), /image|phoenixlogo/);

  const stored = decodeInboundForStorage(WEBHOOK_BODY);
  assert.match(stored, /\[image: Phoenix Logo\]/);
  assert.match(stored, /678-208-6249 \(d\)/);
});

test('the poller history entry carries the RFC Message-ID into listInboundReplies', () => {
  const fromField = listInboundReplies({
    history: [{
      type: 'REPLY',
      time: '2026-11-03T22:03:54.000Z',
      email_body: POLLER_BODY,
      message_id: DAVID_ID,
    }],
  }, 'david.chapman@phoenixpbm.com');
  assert.equal(fromField[0].messageId, DAVID_CANON);
  assert.equal(fromField[0].body.includes('[image: Phoenix Logo]'), false);

  const fromHeader = listInboundReplies({
    history: [{
      type: 'REPLY',
      time: '2026-11-03T22:03:54.000Z',
      email_body: POLLER_BODY,
      headers: `Message-ID: ${DAVID_ID}\r\nFrom: David Chapman <david.chapman@phoenixpbm.com>`,
    }],
  }, 'david.chapman@phoenixpbm.com');
  assert.equal(fromHeader[0].messageId, DAVID_CANON);

  const poller = fs.readFileSync(path.join(ROOT, 'src/services/smartlead-poller.js'), 'utf8');
  assert.match(poller, /RFC Message-ID from the history entry/);
  assert.match(poller, /messageId \|\| null/);
});

test('webhook then poller inserts one row, and two different short replies both post', async () => {
  const db = memoryDb();
  const first = await claim(db, WEBHOOK_BODY, DAVID_ID);
  assert.equal(first.duplicate, false);
  assert.equal(db.rows.length, 1);
  assert.match(db.rows[0].inbound_message, /\[image: Phoenix Logo\]/);

  const second = await claim(db, POLLER_BODY, '');
  assert.equal(second.duplicate, true);
  assert.equal(db.rows.length, 1, 'a missing Message-ID still matches on the text key');

  const sameId = await claim(db, POLLER_BODY, DAVID_ID);
  assert.equal(sameId.duplicate, true);
  assert.equal(db.rows.length, 1, 'the same RFC Message-ID is one email');

  const tuesday = await claim(db, 'Tuesday works', '<tuesday-reply@mail.gmail.com>');
  const wednesday = await claim(db, 'Wednesday works', '<wednesday-reply@mail.gmail.com>');
  assert.equal(tuesday.duplicate, false);
  assert.equal(wednesday.duplicate, false);
  assert.equal(db.rows.length, 3);

  const yes = await claim(db, 'Yes', '');
  const no = await claim(db, 'No', '');
  assert.equal(yes.duplicate, false);
  assert.equal(no.duplicate, false);
  assert.equal(db.rows.length, 5);
});

test('supersede still closes a different open card and does not treat a follow-up as one', () => {
  const supersede = fs.readFileSync(path.join(ROOT, 'src/services/supersede-cards.js'), 'utf8');
  const post = fs.readFileSync(path.join(ROOT, 'src/services/slack-reply-post.js'), 'utf8');
  const dedupe = fs.readFileSync(path.join(ROOT, 'src/services/reply-dedupe.js'), 'utf8');
  assert.match(supersede, /COALESCE\(classification, ''\) <> 'FOLLOW_UP'/);
  assert.match(supersede, /id <> \$5/);
  assert.match(post, /supersedeEarlierOpenCards\(/);
  const recorded = dedupe.slice(
    dedupe.indexOf('async function inboundAlreadyRecorded'),
    dedupe.indexOf('async function alreadyPostedToSlack')
  );
  assert.doesNotMatch(recorded, /interval '/);
});
