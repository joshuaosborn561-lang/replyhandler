// Josh, Oct 27 2026: "just say when you can't find a phone number from FE so i
// know if its that or no credits". A card with no phone says why.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  phoneLookupFromHit, phoneLookupFromError, phoneMissingText,
} = require('../src/utils/phone-lookup-reason');
const { leadFieldText } = require('../src/services/slack');
const { enrichProspect } = require('../src/services/prospect-enrich');
const { enrichPendingReplyPhone } = require('../src/services/reply-phone-enrichment');
const db = require('../src/db');

const REPLY_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';

test('exact card wording per outcome', () => {
  assert.equal(phoneMissingText({ outcome: 'no_match' }), '📵 No phone: FullEnrich searched and found none');
  assert.equal(phoneMissingText({ outcome: 'out_of_credits' }), '📵 No phone: FullEnrich is out of credits');
  assert.equal(phoneMissingText({ outcome: 'timeout' }), '📵 No phone: lookup timed out');
  assert.equal(phoneMissingText({ outcome: 'error' }), '📵 No phone: lookup errored');
  assert.equal(phoneMissingText({ outcome: 'not_run' }), '📵 No phone: FullEnrich not run');
  assert.equal(
    phoneMissingText({ outcome: 'not_run', reason: 'not_hot_reply' }),
    '📵 No phone: FullEnrich not run (only runs for interested replies)',
  );
  assert.equal(
    phoneMissingText({ outcome: 'not_run', reason: 'spend_cap' }),
    '📵 No phone: FullEnrich not run (spend cap)',
  );
  assert.match(phoneMissingText({ outcome: 'unknown' }), /not reported/);
});

test('say nothing when there is no reason yet; failed rows without a receipt read as errored', () => {
  assert.equal(phoneMissingText(null, null), '');
  assert.equal(phoneMissingText(null, 'processing'), '');
  assert.equal(phoneMissingText(null, 'skipped'), '');
  assert.equal(phoneMissingText(null, 'failed'), '📵 No phone: lookup errored');
});

test('errors map to timeout / credits / error', () => {
  const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.deepEqual(phoneLookupFromError(abort), { outcome: 'timeout' });
  assert.deepEqual(phoneLookupFromError(new Error('email-waterfall 402: credits insufficient')), { outcome: 'out_of_credits' });
  assert.deepEqual(phoneLookupFromError(new Error('email-waterfall 500: boom')), { outcome: 'error' });
  assert.deepEqual(phoneLookupFromError(new Error('fetch failed')), { outcome: 'error' });
});

test('waterfall outcome maps to card outcome', () => {
  const fe = (mobile, extra = {}) => ({ fullenrich: { mobile, enabled: true, creditsExhausted: false, ...extra } });
  assert.deepEqual(phoneLookupFromHit(fe('no_match')), { outcome: 'no_match' });
  assert.deepEqual(phoneLookupFromHit(fe('out_of_credits', { creditsExhausted: true })), { outcome: 'out_of_credits' });
  assert.deepEqual(phoneLookupFromHit(fe('timeout')), { outcome: 'timeout' });
  assert.deepEqual(phoneLookupFromHit(fe('error')), { outcome: 'error' });
  assert.deepEqual(phoneLookupFromHit(fe('no_match', { creditsExhausted: true })), { outcome: 'out_of_credits' });
  assert.deepEqual(phoneLookupFromHit(fe('not_run'), { }), { outcome: 'not_run' });
  assert.deepEqual(
    phoneLookupFromHit({ ...fe('not_run'), fullenrichAllowed: false }),
    { outcome: 'not_run', reason: 'not_hot_reply' },
  );
  assert.deepEqual(phoneLookupFromHit({ skipped: 'ceiling' }), { outcome: 'not_run', reason: 'spend_cap' });
  // Older waterfall build says nothing about FullEnrich: never claim "searched, none".
  assert.deepEqual(phoneLookupFromHit({ fullenrich: null }), { outcome: 'unknown' });
});

test('enrichProspect carries the waterfall fullenrich block, null from older builds', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  const original = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true, status: 200,
      async text() {
        return JSON.stringify({ ok: true, fullenrich: { enabled: true, mobile: 'out_of_credits', credits_exhausted: true } });
      },
    });
    const hit = await enrichProspect({ email: 'a@b.co', need: 'phone', maxTier: 'fullenrich' });
    assert.deepEqual(hit.fullenrich, { enabled: true, mobile: 'out_of_credits', creditsExhausted: true });
    global.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } });
    const old = await enrichProspect({ email: 'a@b.co', need: 'phone', maxTier: 'fullenrich' });
    assert.equal(old.fullenrich, null);
  } finally {
    global.fetch = original;
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('card text shows the reason only when there is no phone', () => {
  const receipt = { phoneLookup: { outcome: 'out_of_credits' } };
  const none = leadFieldText({ leadName: 'Pat', leadEmail: 'pat@roof.co', enrichmentReceipt: receipt });
  assert.match(none, /📵 No phone: FullEnrich is out of credits/);
  assert.doesNotMatch(none, /phone number not found/i);
  const withPhone = leadFieldText({
    leadName: 'Pat', leadEmail: 'pat@roof.co', leadPhone: '+12015550100', enrichmentReceipt: receipt,
  });
  assert.doesNotMatch(withPhone, /No phone/);
  const withAlt = leadFieldText({
    leadName: 'Pat', leadEmail: 'pat@roof.co', leadPhoneAlt: '+12015550999', enrichmentReceipt: receipt,
  });
  assert.doesNotMatch(withAlt, /No phone/);
  assert.match(leadFieldText({ leadName: 'Pat', leadEmail: 'pat@roof.co' }), /^\*Pat\*/);
  assert.doesNotMatch(leadFieldText({ leadName: 'Pat', leadEmail: 'pat@roof.co' }), /No phone/);
  // refresh paths pass only the phoneLookup subset: no spend line leaks in
  assert.doesNotMatch(none, /🧾/);
});

function baseReply(over = {}) {
  return {
    id: REPLY_ID, client_id: CLIENT_ID, campaign_id: 'camp-1', lead_name: 'Pat Riley',
    lead_email: 'pat@roof.co', linkedin_url: null, lead_phone: null, lead_phone_provider: null,
    lead_phone_alt: null, lead_website: null, phone_enrichment_status: null,
    phone_enrichment_error: null, phone_enriched_at: null, classification: 'INTERESTED',
    status: 'pending', draft_reply: 'Happy to chat.', enrichment_receipt: null,
    client_name: 'Acme', reply_enrich_ceiling_usd: null, reply_enrich_ceiling_hot_usd: null,
    ...over,
  };
}

function installDb(reply) {
  const calls = [];
  const original = db.query.bind(db);
  db.query = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (/FROM pending_replies pr/.test(sql)) return { rows: [reply] };
    if (/phone_enrichment_status = 'processing'/.test(sql)) return { rows: [{ ...reply }] };
    if (/FROM clients/.test(sql)) return { rows: [{ id: CLIENT_ID, name: 'Acme' }] };
    if (/lead_email = COALESCE/.test(sql)) {
      return { rows: [{
        ...reply,
        lead_phone: params[1],
        enrichment_receipt: JSON.parse(params[6]),
        phone_enrichment_status: params[7],
      }] };
    }
    return { rows: [] };
  };
  return { calls, restore() { db.query = original; } };
}

const emptyIdentity = async () => ({ email: null, phone: null, website: null, linkedinUrl: null, domain: null, sources: {} });

async function runWith(reply, handler) {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  const dbMock = installDb(reply);
  const original = global.fetch;
  global.fetch = handler;
  try {
    const result = await enrichPendingReplyPhone(REPLY_ID, { identityLookup: emptyIdentity });
    return { result, dbMock };
  } finally {
    global.fetch = original;
    dbMock.restore();
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
}

const okJson = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ...obj }); } });

test('FullEnrich searched, found nothing -> receipt says no_match', async () => {
  const { result } = await runWith(baseReply(), async () => okJson({
    fullenrich: { enabled: true, mobile: 'no_match', credits_exhausted: false },
  }));
  assert.equal(result.receipt.phoneLookup.outcome, 'no_match');
});

test('FullEnrich out of credits -> receipt says out_of_credits', async () => {
  const { result } = await runWith(baseReply(), async () => okJson({
    fullenrich: { enabled: true, mobile: 'out_of_credits', credits_exhausted: true },
  }));
  assert.equal(result.receipt.phoneLookup.outcome, 'out_of_credits');
});

test('non-hot reply: FullEnrich not run, with the reason', async () => {
  const { result } = await runWith(baseReply({ classification: 'QUESTION' }), async () => okJson({
    fullenrich: { enabled: true, mobile: 'not_run', credits_exhausted: false },
  }));
  assert.deepEqual(result.receipt.phoneLookup, { outcome: 'not_run', reason: 'not_hot_reply' });
});

test('a found mobile writes no phoneLookup', async () => {
  const { result } = await runWith(baseReply(), async () => okJson({
    phone: '+12015550100', phone_valid: true, phone_type: 'mobile',
    fullenrich: { enabled: true, mobile: 'found', credits_exhausted: false },
  }));
  assert.equal(result.phone, '+12015550100');
  assert.equal(result.receipt.phoneLookup, undefined);
});

test('lookup abort (the waterfall timeout) -> failed row stores a timeout reason', async () => {
  const { result, dbMock } = await runWith(baseReply(), async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.receipt.phoneLookup.outcome, 'timeout');
  const failed = dbMock.calls.find((c) => /enrichment_receipt = \$3::jsonb/.test(c.sql));
  assert.equal(JSON.parse(failed.params[2]).phoneLookup.outcome, 'timeout');
});

test('waterfall 402 / 500 -> out_of_credits / error', async () => {
  const r402 = await runWith(baseReply(), async () => ({
    ok: false, status: 402, async text() { return 'credits insufficient'; },
  }));
  assert.equal(r402.result.receipt.phoneLookup.outcome, 'out_of_credits');
  const r500 = await runWith(baseReply(), async () => ({
    ok: false, status: 500, async text() { return 'boom'; },
  }));
  assert.equal(r500.result.receipt.phoneLookup.outcome, 'error');
});
