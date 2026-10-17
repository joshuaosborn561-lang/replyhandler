const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyAlloWebhookSignature,
  signAlloWebhook,
} = require('../src/utils/allo-webhook-signature');
const {
  DEFAULT_NUMBER_CLIENTS,
  MESA_ENERGY_NUMBER,
  numberClientMap,
  userClientMap,
  resolveClientHint,
} = require('../src/utils/allo-client-map');
const {
  inspectCallBooking,
  hasMeetingBookedTag,
  extractEmails,
  extractProposedTimes,
  isPlaceholderProspect,
  isManualBookClient,
  isSalesGliderClient,
  SALESGLIDER_CALENDLY,
} = require('../src/utils/allo-call-booking');
const {
  SOURCE_ALLO,
  SOURCE_EMAIL,
  DEFAULT_CHANNEL_ID,
  buildMeetingsBookedCard,
  handleAlloWebhookEvent,
  recapCountsFromRows,
  buildMeetingsRecapText,
  sourceLabel,
} = require('../src/services/allo-meetings');
const db = require('../src/db');

const SECRET = 'whsec_' + Buffer.from('allo-test-signing-key-bytes!!').toString('base64');

const SAMPLE_CALL_COMPLETED = {
  topic: 'call.completed',
  version: '2.0',
  timestamp: '2026-10-17T18:45:00.000Z',
  data: {
    id: 'cll_mesaBooked1',
    start_date: '2026-10-17T18:30:00.000Z',
    from_number: '+19162701857',
    from_name: 'Gabe',
    to: '+15551230001',
    to_name: 'Dana Miles',
    tags: ['Meeting Booked'],
    tag: 'Meeting Booked',
    summary:
      'Dana agreed to a meeting. She gave dana.miles@acme.com and asked for Tuesday 10am or Thursday 2pm.',
    transcriptions: [
      { source: 'USER', time: '2026-10-17T18:31:00.000Z', text: 'Can we lock two times plus an email?' },
      { source: 'EXTERNAL', time: '2026-10-17T18:32:00.000Z', text: 'Tuesday at 10am or Thursday at 2pm works. Email me at dana.miles@acme.com.' },
    ],
    concatenated_transcript:
      'Can we lock two times plus an email? Tuesday at 10am or Thursday at 2pm works. Email me at dana.miles@acme.com.',
    type: 'OUTBOUND',
    result: 'ANSWERED',
    user_email: 'gabe@example.com',
  },
};

const SAMPLE_TAG_ADDED = {
  topic: 'tag.added',
  version: '2.0',
  timestamp: '2026-10-17T18:50:00.000Z',
  data: {
    call_id: 'cll_sgBooked2',
    tag_key: 'meeting_booked',
    tag_name: 'Meeting Booked',
    user_email: 'gabe@example.com',
  },
};

const TAG_ADDED_CALL = {
  id: 'cll_sgBooked2',
  start_date: '2026-10-17T18:20:00.000Z',
  from_number: '+12145550100',
  to: '+15559870000',
  to_name: 'Pat Lee',
  tags: ['Meeting Booked'],
  summary: 'Pat booked Josh on Calendly for a 30 minute intro.',
  concatenated_transcript: 'I just booked https://calendly.com/joshua-salesglidergrowth/30min for Tuesday at 2pm. I am Pat Lee, pat.lee@firm.com.',
  type: 'OUTBOUND',
  user_email: 'gabe@example.com',
  extracted_data: { contact: { name: 'Pat Lee', emails: ['pat.lee@firm.com'] } },
};

function signedHeaders(body, { webhookId = 'msg_test1', timestamp } = {}) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  return signAlloWebhook({
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    webhookId,
    timestamp: ts,
    secret: SECRET,
  });
}

function memoryDb() {
  const webhooks = new Set();
  const meetings = [];
  const clients = [
    {
      id: 'client-mesa',
      name: 'Mesa Energy',
      slack_bot_token: 'xoxb-mesa',
      slack_channel_id: 'C-MESA',
    },
    {
      id: 'client-sg',
      name: 'SalesGlider',
      slack_bot_token: 'xoxb-sg',
      slack_channel_id: 'C-SG',
    },
  ];
  const followUps = [];

  const original = db.query.bind(db);
  db.query = async (sql, params = []) => {
    const q = String(sql);

    if (/INSERT INTO allo_webhook_events/.test(q)) {
      const id = params[0];
      if (webhooks.has(id)) return { rows: [] };
      webhooks.add(id);
      return { rows: [{ webhook_id: id }] };
    }
    if (/DELETE FROM allo_webhook_events/.test(q)) {
      webhooks.delete(params[0]);
      return { rows: [] };
    }
    if (/FROM clients/.test(q) && /regexp_replace/.test(q)) {
      const want = String(params[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const row = clients.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want);
      return { rows: row ? [row] : [] };
    }
    if (/SELECT slack_bot_token FROM clients/.test(q)) {
      return { rows: [{ slack_bot_token: clients[1].slack_bot_token }] };
    }
    if (/FROM meetings/.test(q) && /lower\(lead_email\)/.test(q) && /status = 'booked'/.test(q) && !/created_at > now/.test(q)) {
      const row = meetings.find((m) => (
        m.client_id === params[0]
        && String(m.lead_email || '').toLowerCase() === String(params[1] || '')
        && m.status === 'booked'
      ));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/FROM meetings/.test(q) && /allo_call_id = \$1/.test(q) && /LIMIT 1/.test(q) && !/created_at > now/.test(q)) {
      const row = meetings.find((m) => m.allo_call_id === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/FROM meetings/.test(q) && /created_at > now/.test(q)) {
      const clientId = params[0];
      const email = String(params[2] || '');
      const phone = String(params[3] || '');
      const exclude = String(params[4] || '');
      const row = meetings.find((m) => {
        if (m.client_id !== clientId) return false;
        if (exclude && m.allo_call_id === exclude) return false;
        if (email && String(m.lead_email || '').toLowerCase() === email) return true;
        if (phone && String(m.lead_phone || '').replace(/\D/g, '').slice(-10) === phone) return true;
        return false;
      });
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE meetings/.test(q) && /source_confidence/.test(q)) {
      const id = params[0];
      const m = meetings.find((x) => x.id === id);
      if (m && params[1] === 'confirmed') {
        m.status = 'booked';
        m.source_confidence = 'confirmed';
      }
      return { rows: m ? [m] : [] };
    }
    if (/INSERT INTO meetings/.test(q)) {
      const row = {
        id: `mtg_${meetings.length + 1}`,
        client_id: params[0],
        lead_name: params[1],
        lead_email: params[2],
        lead_phone: params[3],
        proposed_time: params[4],
        proposed_times: params[5],
        confirmed_time: params[6],
        status: params[7],
        source: params[8],
        source_confidence: params[9],
        allo_call_id: params[10],
        allo_webhook_id: params[11],
        allo_user_email: params[12],
        allo_tags: params[13],
        prospect_kind: params[14],
        created_at: new Date().toISOString(),
      };
      meetings.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/SET slack_channel_id/.test(q)) {
      const m = meetings.find((x) => x.id === params[0]);
      if (m) {
        m.slack_channel_id = params[1];
        m.slack_message_ts = params[2];
      }
      return { rows: [] };
    }
    if (/UPDATE outbound_follow_ups/.test(q)) {
      followUps.push({ sql: q, params });
      return { rowCount: 0, rows: [] };
    }
    if (/FROM pending_replies/.test(q)) return { rows: [] };
    return { rows: [] };
  };

  return {
    webhooks,
    meetings,
    clients,
    followUps,
    restore() { db.query = original; },
  };
}

describe('Allo webhook signatures', () => {
  it('rejects when the signing secret is unset', () => {
    const r = verifyAlloWebhookSignature({
      rawBody: '{}',
      headers: { 'webhook-id': 'a', 'webhook-timestamp': '1', 'webhook-signature': 'v1,abc' },
      secret: '',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
  });

  it('rejects unsigned and invalid signatures', () => {
    const raw = JSON.stringify(SAMPLE_CALL_COMPLETED);
    assert.equal(verifyAlloWebhookSignature({
      rawBody: raw,
      headers: {},
      secret: SECRET,
    }).error, 'missing_signature');

    const ts = Math.floor(Date.now() / 1000);
    const bad = verifyAlloWebhookSignature({
      rawBody: raw,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      secret: SECRET,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.equal(bad.error, 'invalid_signature');
  });

  it('accepts a valid HMAC and rejects a tampered body', () => {
    const raw = JSON.stringify(SAMPLE_CALL_COMPLETED);
    const headers = signedHeaders(raw);
    const ok = verifyAlloWebhookSignature({ rawBody: raw, headers, secret: SECRET });
    assert.equal(ok.ok, true);
    assert.equal(ok.webhookId, 'msg_test1');

    const tampered = verifyAlloWebhookSignature({
      rawBody: raw.replace('Dana', 'Nope'),
      headers,
      secret: SECRET,
    });
    assert.equal(tampered.ok, false);
  });
});

describe('Allo client mapping', () => {
  it('defaults Mesa Energy to (916) 270-1857 and leaves others to env', () => {
    assert.equal(MESA_ENERGY_NUMBER, '9162701857');
    assert.equal(DEFAULT_NUMBER_CLIENTS['9162701857'], 'Mesa Energy');
    const mapped = numberClientMap({});
    assert.equal(mapped['9162701857'], 'Mesa Energy');
    assert.equal(Object.keys(mapped).length, 1);
  });

  it('maps SalesGlider / Deep Roots from env, not hardcoded numbers', () => {
    const env = {
      ALLO_NUMBER_CLIENT_MAP: JSON.stringify({
        '2145550100': 'SalesGlider',
        '+12184693457': 'Deep Roots Capital',
      }),
      ALLO_USER_CLIENT_MAP: JSON.stringify({
        'gabe@example.com': 'Mesa Energy',
      }),
    };
    const numbers = numberClientMap(env);
    assert.equal(numbers['2145550100'], 'SalesGlider');
    assert.equal(numbers['2184693457'], 'Deep Roots Capital');
    assert.equal(userClientMap(env)['gabe@example.com'], 'Mesa Energy');

    const hint = resolveClientHint(
      { type: 'OUTBOUND', from_number: '+12145550100', to: '+15559870000' },
      {},
      env,
    );
    assert.equal(hint.clientName, 'SalesGlider');
    assert.equal(hint.via, 'allo_number');
  });
});

describe('Allo booking inspection', () => {
  it('treats Meeting Booked tags as confirmed and pulls email + times', () => {
    const info = inspectCallBooking(SAMPLE_CALL_COMPLETED.data);
    assert.equal(info.confidence, 'confirmed');
    assert.equal(info.email, 'dana.miles@acme.com');
    assert.ok(info.proposedTimes.some((t) => /tuesday/i.test(t)));
    assert.ok(info.proposedTimes.some((t) => /thursday/i.test(t)));
    assert.equal(info.prospectKind, 'interested');
    assert.ok(hasMeetingBookedTag({ tags: ['meeting_booked'] }));
  });

  it('falls back to likely from summary/transcript without a tag', () => {
    const info = inspectCallBooking({
      summary: 'Prospect booked a time on the calendar for Friday at 3pm.',
      tags: [],
      to_name: 'Alex',
    });
    assert.equal(info.confidence, 'likely');
    assert.equal(info.booked, true);
  });

  it('marks nameless no-email calls as placeholder', () => {
    assert.equal(isPlaceholderProspect({ name: '', email: '' }), true);
    assert.equal(isPlaceholderProspect({ name: 'Dana Miles', email: 'd@x.com' }), false);
    assert.equal(extractEmails('reach me at A@B.COM')[0], 'a@b.com');
    assert.ok(extractProposedTimes('How about Tuesday at 10am').length);
    assert.ok(isManualBookClient('Mesa Energy'));
    assert.ok(isManualBookClient('Deep Roots Capital'));
    assert.ok(isSalesGliderClient('SalesGlider'));
    assert.equal(SALESGLIDER_CALENDLY, 'https://calendly.com/joshua-salesglidergrowth/30min');
  });
});

describe('Slack card + recap counts', () => {
  it('labels Allo vs email and keeps likely out of confirmed recap counts', () => {
    const card = buildMeetingsBookedCard({
      clientName: 'Mesa Energy',
      source: SOURCE_ALLO,
      confidence: 'confirmed',
      leadName: 'Dana Miles',
      leadEmail: 'dana.miles@acme.com',
      leadPhone: '+15551230001',
      proposedTimes: ['Tuesday at 10am', 'Thursday at 2pm'],
      prospectKind: 'interested',
      summary: 'Agreed to meet.',
    });
    assert.match(card.text, /Allo call/);
    assert.match(card.blocks[1].text.text, /\*Source:\* Allo call/);
    assert.match(card.blocks[1].text.text, /Josh books by hand/);
    assert.equal(card.blocks[1].text.text.includes('likely'), false);

    const likelyCard = buildMeetingsBookedCard({
      clientName: 'SalesGlider',
      source: SOURCE_ALLO,
      confidence: 'likely',
      leadName: 'Pat Lee',
      leadEmail: 'pat.lee@firm.com',
      prospectKind: 'interested',
    });
    assert.match(likelyCard.text, /likely/i);
    assert.match(likelyCard.blocks[1].text.text, /calendly/i);
    assert.equal(sourceLabel(SOURCE_EMAIL, 'confirmed'), 'email');

    const recap = recapCountsFromRows([
      {
        id: 1, client_name: 'Mesa Energy', lead_name: 'Dana Miles',
        lead_email: 'dana.miles@acme.com', source: SOURCE_ALLO,
        source_confidence: 'confirmed', created_at: '2026-10-17T18:40:00Z',
      },
      {
        id: 2, client_name: 'Goliath', lead_name: 'Cal User',
        lead_email: 'cal@x.com', source: SOURCE_EMAIL,
        source_confidence: 'confirmed', created_at: '2026-10-17T18:41:00Z',
      },
      {
        id: 3, client_name: 'SalesGlider', lead_name: 'Maybe',
        lead_email: 'maybe@x.com', source: SOURCE_ALLO,
        source_confidence: 'likely', created_at: '2026-10-17T18:42:00Z',
      },
      {
        id: 4, client_name: 'Goliath', lead_name: 'Cal User',
        lead_email: 'cal@x.com', source: SOURCE_ALLO,
        source_confidence: 'confirmed', created_at: '2026-10-17T18:50:00Z',
      },
    ]);
    assert.equal(recap.confirmed, 2);
    assert.equal(recap.likely, 1);
    assert.equal(recap.by_source.allo_call, 1);
    assert.equal(recap.by_source.email, 1);

    const text = buildMeetingsRecapText({
      period: 'day',
      label: 'Fri Oct 17, 2026',
      clients: recap.meetings.map((m) => ({ name: m.client_name, slug: m.slug })),
      meetings: recap.meetings,
      likelyMeetings: recap.likely_meetings,
    });
    assert.match(text, /Daily recap/);
    assert.match(text, /Allo call/);
    assert.match(text, /email/);
    assert.match(text, /Likely \(not confirmed\)/);
  });
});

describe('call.completed + tag.added produce labeled cards and recap counts', () => {
  it('posts a confirmed Mesa Allo card from call.completed', async () => {
    const fake = memoryDb();
    const posted = [];
    try {
      const result = await handleAlloWebhookEvent(SAMPLE_CALL_COMPLETED, {
        webhookId: 'msg_call_completed_1',
        postCard: async (booking) => {
          posted.push(booking);
          return { ts: '111.222' };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.skipped, undefined);
      assert.equal(result.confidence, 'confirmed');
      assert.equal(result.clientName, 'Mesa Energy');
      assert.equal(result.source, SOURCE_ALLO);
      assert.equal(result.prospectKind, 'interested');
      assert.equal(posted.length, 1);
      assert.match(result.card.text, /Allo call/);
      assert.match(result.card.blocks[1].text.text, /dana\.miles@acme\.com/);
      assert.equal(fake.meetings.length, 1);
      assert.equal(fake.meetings[0].source, SOURCE_ALLO);
      assert.equal(fake.meetings[0].source_confidence, 'confirmed');

      const recap = recapCountsFromRows(fake.meetings.map((m) => ({
        ...m,
        client_name: 'Mesa Energy',
      })));
      assert.equal(recap.confirmed, 1);
      assert.equal(recap.by_source.allo_call, 1);
      assert.equal(recap.likely, 0);
    } finally {
      fake.restore();
    }
  });

  it('is idempotent when Allo retries the same webhook-id', async () => {
    const fake = memoryDb();
    try {
      const first = await handleAlloWebhookEvent(SAMPLE_CALL_COMPLETED, {
        webhookId: 'msg_retry_same',
        postCard: async () => ({ ts: '1.1' }),
      });
      const second = await handleAlloWebhookEvent(SAMPLE_CALL_COMPLETED, {
        webhookId: 'msg_retry_same',
        postCard: async () => { throw new Error('should not post'); },
      });
      assert.equal(first.ok, true);
      assert.equal(second.skipped, 'duplicate_webhook');
      assert.equal(fake.meetings.length, 1);
    } finally {
      fake.restore();
    }
  });

  it('posts a SalesGlider card from tag.added after fetching the call', async () => {
    const fake = memoryDb();
    const posted = [];
    const env = {
      ...process.env,
      ALLO_NUMBER_CLIENT_MAP: JSON.stringify({ '2145550100': 'SalesGlider' }),
    };
    try {
      const result = await handleAlloWebhookEvent(SAMPLE_TAG_ADDED, {
        webhookId: 'msg_tag_added_1',
        fetchCall: async (id) => {
          assert.equal(id, 'cll_sgBooked2');
          return TAG_ADDED_CALL;
        },
        postCard: async (booking) => {
          posted.push(booking);
          return { ts: '333.444' };
        },
        env,
      });
      assert.equal(result.ok, true);
      assert.equal(result.confidence, 'confirmed');
      assert.equal(result.clientName, 'SalesGlider');
      assert.equal(posted[0].leadEmail, 'pat.lee@firm.com');
      assert.match(result.card.blocks[1].text.text, /calendly\.com\/joshua-salesglidergrowth\/30min/);
      const recap = recapCountsFromRows(fake.meetings.map((m) => ({
        ...m, client_name: 'SalesGlider',
      })));
      assert.equal(recap.confirmed, 1);
      assert.equal(recap.by_source.allo_call, 1);
    } finally {
      fake.restore();
    }
  });

  it('labels likely bookings and does not count them as confirmed', async () => {
    const fake = memoryDb();
    try {
      const result = await handleAlloWebhookEvent({
        topic: 'call.completed',
        data: {
          id: 'cll_likely1',
          from_number: '+19162701857',
          to: '+15550001111',
          to_name: 'Sam',
          tags: [],
          summary: 'Sam said Tuesday at 3pm works and asked us to send an invite to sam@x.com.',
          type: 'OUTBOUND',
        },
      }, {
        webhookId: 'msg_likely',
        postCard: async () => ({ ts: '5.5' }),
      });
      assert.equal(result.confidence, 'likely');
      assert.match(result.card.text, /likely/i);
      const recap = recapCountsFromRows(fake.meetings.map((m) => ({
        ...m, client_name: 'Mesa Energy',
      })));
      assert.equal(recap.confirmed, 0);
      assert.equal(recap.likely, 1);
    } finally {
      fake.restore();
    }
  });

  it('does not double-count when the same prospect already booked by email', async () => {
    const fake = memoryDb();
    fake.meetings.push({
      id: 'existing-email',
      client_id: 'client-mesa',
      lead_email: 'dana.miles@acme.com',
      lead_phone: null,
      source: SOURCE_EMAIL,
      source_confidence: 'confirmed',
      status: 'booked',
      allo_call_id: null,
      created_at: new Date().toISOString(),
    });
    try {
      const result = await handleAlloWebhookEvent(SAMPLE_CALL_COMPLETED, {
        webhookId: 'msg_dedupe_email',
        postCard: async () => { throw new Error('must not Slack-card a duplicate'); },
      });
      assert.equal(result.skipped, 'duplicate_email_or_phone');
      const recap = recapCountsFromRows(fake.meetings.map((m) => ({
        ...m,
        client_name: 'Mesa Energy',
        lead_email: m.lead_email,
      })));
      assert.equal(recap.confirmed, 1);
      assert.equal(recap.by_source.email, 1);
      assert.equal(recap.by_source.allo_call || 0, 0);
    } finally {
      fake.restore();
    }
  });
});

describe('Allo webhook path + channel defaults', () => {
  it('registers POST /webhook/allo and keeps the JSON body limit', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/allo-webhook.js'), 'utf8');
    assert.match(index, /\/webhook\/allo/);
    assert.match(index, /JSON_BODY_LIMIT\s*\|\|\s*'5mb'/);
    assert.match(index, /req\.rawBody/);
    assert.match(route, /router\.post\('\/webhook\/allo'/);
    assert.equal(DEFAULT_CHANNEL_ID, 'C0BRBK7H4BF');
  });
});
