const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  clientNotifyMode, isDigestEligible, digestRecipients, queueForDigest, groupByLead, buildDigestEmail, runClientReplyDigest,
} = require('../src/services/client-reply-digest');

const JOSH = 'joshua@salesglidergrowth.com';
const CAYDEN = 'cayden@salesglidergrowth.com';

function reply(over = {}) {
  return {
    id: 'r1', client_id: 'c1', platform: 'smartlead', classification: 'INTERESTED', follow_up_id: null,
    lead_id: '10', lead_name: 'Pat', lead_full_name: 'Pat Example', lead_email: 'pat@example.test', lead_title: 'Owner',
    lead_company: 'Example Mechanical', lead_phone: '555-0100', linkedin_url: 'https://www.linkedin.com/in/pat-example',
    campaign_name: 'Central Owners',
    inbound_message: 'Yes, interested.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Rep <r@x.test> wrote:\n> hi',
    sent_reply: 'Great, here are two times.', created_at: '2026-10-29T15:00:00Z', updated_at: '2026-10-29T16:00:00Z',
    ...over,
  };
}

describe('client roll-up: mode and eligibility', () => {
  it('defaults to roll-up; instant and off are explicit', () => {
    assert.equal(clientNotifyMode({}), 'rollup');
    assert.equal(clientNotifyMode({ PROSPECT_REPLY_NOTIFY_MODE: 'garbage' }), 'rollup');
    assert.equal(clientNotifyMode({ PROSPECT_REPLY_NOTIFY_MODE: ' Instant ' }), 'instant');
    assert.equal(clientNotifyMode({ PROSPECT_REPLY_NOTIFY_MODE: 'off' }), 'off');
  });
  it('only positive Smartlead replies that are not follow-up nudges are queued', () => {
    assert.equal(isDigestEligible(reply()), true);
    assert.equal(isDigestEligible(reply({ classification: 'MEETING_PROPOSED' })), true);
    for (const c of ['QUESTION', 'NOT_INTERESTED', 'OOO', 'FOLLOW_UP', 'WRONG_PERSON']) {
      assert.equal(isDigestEligible(reply({ classification: c })), false, c);
    }
    assert.equal(isDigestEligible(reply({ follow_up_id: 'f1' })), false);
    assert.equal(isDigestEligible(reply({ platform: 'heyreach' })), false);
    assert.equal(isDigestEligible(null), false);
  });
});

describe('client roll-up: recipients', () => {
  it('To is the client list and round-robin pool, CC is Cayden and Josh, nobody twice', () => {
    const r = digestRecipients({ cc_emails: 'a@client.test, b@client.test', cc_round_robin_emails: 'b@client.test, c@client.test' }, {});
    assert.deepEqual(r.to, ['a@client.test', 'b@client.test', 'c@client.test']);
    assert.deepEqual(r.cc, [CAYDEN, JOSH]);
  });
  it('a client list that includes Josh or Cayden does not list them twice', () => {
    const r = digestRecipients({ cc_emails: `a@client.test, ${JOSH}` }, {});
    assert.deepEqual(r.to, ['a@client.test']);
    assert.ok(r.cc.includes(JOSH));
  });
});

describe('client roll-up: queue and render', () => {
  it('queueForDigest flags the row and never throws', async () => {
    const calls = [];
    assert.equal(await queueForDigest('r1', { query: async (sql, p) => { calls.push([sql, p]); return { rowCount: 1 }; } }), true);
    assert.match(calls[0][0], /client_digest_status = 'pending'/);
    assert.deepEqual(calls[0][1], ['r1']);
    assert.equal(await queueForDigest('r1', { query: async () => { throw new Error('db'); } }), false);
  });
  it('one entry per prospect with their reply and ours, quoted history stripped', () => {
    const leads = groupByLead([reply(), reply({ id: 'r2', inbound_message: 'Thursday works.', sent_reply: 'Booked.', created_at: '2026-10-29T17:00:00Z' })]);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].exchanges.length, 2);
    assert.equal(leads[0].exchanges[0].their, 'Yes, interested.');
    assert.equal(leads[0].name, 'Pat Example');
  });
  it('the email carries the prospect, the reply, our answer, and no key-like content', () => {
    const { subject, htmlBody, textBody } = buildDigestEmail({ clientName: 'Acme', leads: groupByLead([reply()]), now: new Date('2026-10-29T21:00:00Z') });
    assert.match(subject, /^Positive replies: 1 prospect · Acme · Oct 29$/);
    for (const needle of ['Pat Example', 'Example Mechanical', 'Yes, interested.', 'Great, here are two times.', 'pat@example.test']) {
      assert.ok(htmlBody.includes(needle) && textBody.includes(needle), needle);
    }
    assert.ok(!htmlBody.includes('wrote:'));
  });
});

// A tiny in-memory stand-in for the two statements the roll-up runs.
function fakeDb(rowsByClient, clients) {
  const state = new Map();
  for (const rs of Object.values(rowsByClient)) for (const r of rs) state.set(r.id, { ...r, ds: 'pending' });
  const log = [];
  const query = async (sql, params) => {
    log.push(sql.trim().split('\n')[0]);
    if (/SET client_digest_status = 'pending', client_digest_claimed_at = NULL\s+WHERE client_digest_status = 'sending'/.test(sql)) return { rows: [] };
    if (/SET client_digest_status = 'sending'/.test(sql)) {
      const out = [];
      for (const r of state.values()) if (r.ds === 'pending') { r.ds = 'sending'; out.push(r); }
      return { rows: out };
    }
    if (/FROM clients/.test(sql)) return { rows: [clients[params[0]]].filter(Boolean) };
    if (/SET client_digest_status = \$2/.test(sql)) {
      for (const id of params[0]) state.get(id).ds = params[1];
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  };
  return { query, state, log };
}

describe('client roll-up: run', () => {
  const clients = {
    c1: { id: 'c1', name: 'Acme', cc_emails: 'a@client.test' },
    c2: { id: 'c2', name: 'Beta', cc_emails: 'b@client.test' },
    c3: { id: 'c3', name: 'Gamma', cc_emails: '' },
  };

  it('sends nothing on an empty day', async () => {
    const sent = [];
    const { query } = fakeDb({}, clients);
    const s = await runClientReplyDigest({ query, send: async (m) => sent.push(m), env: {} });
    assert.equal(sent.length, 0);
    assert.equal(s.replies, 0);
  });

  it('sends ONE email per client, marks rows sent, copies Josh and Cayden', async () => {
    const sent = [];
    const db = fakeDb({
      c1: [reply({ id: 'a1' }), reply({ id: 'a2', lead_email: 'sam@example.test', lead_full_name: 'Sam Other' })],
      c2: [reply({ id: 'b1', client_id: 'c2' })],
    }, clients);
    const s = await runClientReplyDigest({ query: db.query, send: async (m) => sent.push(m), env: {} });
    assert.equal(sent.length, 2);
    const acme = sent.find((m) => m.subject.includes('Acme'));
    assert.match(acme.subject, /2 prospects/);
    assert.deepEqual(acme.to, ['a@client.test']);
    assert.deepEqual(acme.cc, [CAYDEN, JOSH]);
    assert.equal(acme.replyTo, JOSH);
    assert.deepEqual([...db.state.values()].map((r) => r.ds), ['sent', 'sent', 'sent']);
    assert.equal(s.sent, 2);
  });

  it('a failed send puts that client back in the queue and still sends the others', async () => {
    const db = fakeDb({ c1: [reply({ id: 'a1' })], c2: [reply({ id: 'b1', client_id: 'c2' })] }, clients);
    const sent = [];
    const s = await runClientReplyDigest({
      query: db.query,
      send: async (m) => { if (m.subject.includes('Acme')) throw new Error('gmail down'); sent.push(m); },
      env: {},
    });
    assert.equal(sent.length, 1);
    assert.equal(db.state.get('a1').ds, 'pending');
    assert.equal(db.state.get('b1').ds, 'sent');
    assert.equal(s.failed, 1);
  });

  it('a client with no notify list gets nothing and is not retried forever', async () => {
    const db = fakeDb({ c3: [reply({ id: 'g1', client_id: 'c3' })] }, clients);
    const sent = [];
    const s = await runClientReplyDigest({ query: db.query, send: async (m) => sent.push(m), env: {} });
    assert.equal(sent.length, 0);
    assert.equal(db.state.get('g1').ds, 'sent');
    assert.equal(s.skipped, 1);
  });
});
