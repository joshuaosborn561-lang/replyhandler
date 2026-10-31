const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  slugFromClientName,
  assembleRecap,
  CLIENT_SLUG_ALIASES,
} = require('../src/services/booking-bridge');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function row(over) {
  return {
    id: 'p',
    client_id: 'c',
    client_name: 'Acme Solar',
    lead_name: 'Pat',
    lead_email: 'pat@prospect.example',
    classification: 'INTERESTED',
    platform: 'smartlead',
    created_at: '2026-10-26T15:00:00Z',
    ...over,
  };
}

describe('weekly recap: one person, one client block', () => {
  it('maps Vector and Nutter name variants onto one slug', () => {
    assert.equal(slugFromClientName('Vector'), 'vector');
    assert.equal(slugFromClientName('Vector Energy Group'), 'vector');
    assert.equal(slugFromClientName('Nutter'), 'nutter');
    assert.equal(slugFromClientName('Nutter Group'), 'nutter');
    assert.ok(CLIENT_SLUG_ALIASES.vector.includes('Vector'));
    assert.ok(CLIENT_SLUG_ALIASES.vector.includes('Vector Energy Group'));
    assert.ok(CLIENT_SLUG_ALIASES.nutter.includes('Nutter'));
    assert.ok(CLIENT_SLUG_ALIASES.nutter.includes('Nutter Group'));
    assert.equal(slugFromClientName('Acme Solar'), 'acmesolar');
  });

  it('dedupes one person per client and merges duplicate rows and aliases', () => {
    const folded = assembleRecap({
      clients: [
        {
          id: 'v1',
          name: 'Vector Energy Group',
          contact_email: 'ada@vector.example',
          notify_emails: 'ada@vector.example',
        },
        { id: 'v2', name: 'Vector', cc_email: 'ops@vector.example' },
        { id: 'n1', name: 'Nutter', cc_round_robin_emails: 'rep@nutter.example' },
        { id: 'n2', name: 'Nutter Group', cc_emails: 'Pat <pat@gmail.com>' },
        { id: 'a1', name: 'Acme Solar' },
      ],
      positives: [
        row({
          id: 'p1', client_id: 'v1', client_name: 'Vector Energy Group',
          lead_email: 'sam@prospect.example', lead_name: 'Sam',
          created_at: '2026-10-26T15:00:00Z',
        }),
        row({
          id: 'p2', client_id: 'v2', client_name: 'Vector',
          lead_email: 'Sam@prospect.example', lead_name: 'Sam',
          classification: 'QUESTION', platform: 'heyreach',
          created_at: '2026-10-27T15:00:00Z',
        }),
        row({
          id: 'p3', client_id: 'v1', client_name: 'Vector Energy Group',
          lead_email: 'ada@vector.example', lead_name: 'Ada',
        }),
        row({
          id: 'p4', client_id: 'v2', client_name: 'Vector',
          lead_email: 'other@vector.example', lead_name: 'Other',
        }),
        row({
          id: 'p5', client_id: 'n2', client_name: 'Nutter Group',
          lead_email: 'pat@gmail.com', lead_name: 'Pat',
        }),
        row({
          id: 'p6', client_id: 'n1', client_name: 'Nutter',
          lead_email: 'other@gmail.com', lead_name: 'Other',
          created_at: '2026-10-27T12:00:00Z',
        }),
        row({
          id: 'p7', client_id: 'n1', client_name: 'Nutter',
          lead_email: 'jamie@buyer.example', lead_name: 'Jamie',
          classification: 'MEETING_PROPOSED',
          created_at: '2026-10-28T15:00:00Z',
        }),
        row({
          id: 'p8', client_id: 'n1', client_name: 'Nutter',
          lead_email: 'staff@nutter.example', lead_name: 'Staff',
        }),
        row({
          id: 'p9', client_id: 'a1', client_name: 'Acme Solar',
          lead_email: 'lee@prospect.example', lead_name: 'Lee',
          created_at: '2026-10-28T16:00:00Z',
        }),
        row({
          id: 'p10', client_id: 'a1', client_name: 'Acme Solar',
          lead_email: null, lead_name: 'No Email',
          created_at: '2026-10-28T17:00:00Z',
        }),
        row({
          id: 'p11', client_id: 'a1', client_name: 'Acme Solar',
          lead_email: '', lead_name: 'Also Blank',
          created_at: '2026-10-28T18:00:00Z',
        }),
        row({
          id: 'gone', client_id: 'deep', client_name: 'Deep Roots',
          lead_email: 'x@prospect.example', lead_name: 'Skipped',
        }),
      ],
    });

    const names = folded.clients.map((c) => c.name);
    assert.deepEqual(names, ['Acme Solar', 'Nutter Group', 'Vector Energy Group']);
    const vector = folded.clients.find((c) => c.slug === 'vector');
    assert.deepEqual(vector.client_ids.sort(), ['v1', 'v2']);
    assert.ok(vector.aliases.includes('Vector'));
    assert.ok(vector.aliases.includes('Vector Energy Group'));
    const nutter = folded.clients.find((c) => c.slug === 'nutter');
    assert.equal(nutter.name, 'Nutter Group');
    assert.deepEqual(nutter.client_ids.sort(), ['n1', 'n2']);

    const bySlug = {};
    for (const p of folded.positives) {
      if (!bySlug[p.slug]) bySlug[p.slug] = [];
      bySlug[p.slug].push(p.lead_email);
    }
    assert.deepEqual(bySlug.vector, ['sam@prospect.example']);
    assert.deepEqual(bySlug.nutter, ['other@gmail.com', 'jamie@buyer.example']);
    assert.deepEqual(bySlug.acmesolar, ['lee@prospect.example', null, null]);
    assert.equal(folded.positives.find((p) => p.slug === 'vector').client_name, 'Vector Energy Group');
    assert.equal(folded.positives.some((p) => p.client_name === 'Deep Roots'), false);
    assert.equal(folded.totals, undefined);
  });

  it('a meetings total equals the sum of the printed client lines', () => {
    const meetings = [
      { client_id: 'v1', status: 'booked' },
      { client_id: 'v2', status: 'booked' },
      { client_name: 'Nutter', status: 'booked' },
      { client_name: 'Nutter Group', status: 'cancelled' },
      { client_name: 'Nutter', status: 'rescheduled' },
      { client_name: 'Nutter', cancelled_at: '2026-10-29T00:00:00Z', status: 'booked' },
      { status: 'booked' },
      { client_name: 'Deep Roots', status: 'booked' },
    ];
    const folded = assembleRecap({
      clients: [
        { id: 'v1', name: 'Vector Energy Group' },
        { id: 'v2', name: 'Vector' },
        { id: 'n1', name: 'Nutter Group' },
      ],
      positives: [],
      meetings,
    });
    const lineSum = folded.blocks.reduce((sum, block) => sum + block.meetings, 0);
    assert.equal(folded.totals.meetings, lineSum);
    assert.equal(folded.totals.meetings, 3);
    assert.equal(folded.blocks.find((b) => b.slug === 'vector').meetings, 2);
    assert.equal(folded.blocks.find((b) => b.slug === 'nutter').meetings, 1);
    assert.notEqual(meetings.length, folded.totals.meetings);
  });

  it('the recap query does not count meetings', () => {
    const src = read('src/services/booking-bridge.js');
    const start = src.indexOf('async function buildRecap');
    const end = src.indexOf('function normalizeEmail');
    const fn = src.slice(start, end);
    assert.match(fn, /c\.active IS DISTINCT FROM false/);
    assert.match(fn, /contact_email, cc_email, cc_emails/);
    assert.match(fn, /cc_round_robin_emails, notify_emails/);
    assert.doesNotMatch(fn, /FROM meetings/i);
    assert.doesNotMatch(fn, /booking_events/);
    assert.doesNotMatch(fn, /Total:/);
    const route = read('src/routes/booking-bridge-recap.js');
    assert.doesNotMatch(route, /Total:/);
    assert.doesNotMatch(route, /meetings-booked/);
  });
});
