const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  TIER_ORDER,
  DEFAULT_CEILING_USD,
  HOT_CEILING_USD,
  normalizeMaxTier,
  allowsTier,
  resolveReplyEnrichCeiling,
  estimateNeedUsd,
  canAfford,
  dropMaxTierToFit,
  allowsFullEnrichMobile,
  resolvePhoneMaxTier,
  gateMobilePhone,
  FORBIDDEN_WRITE_COLUMNS,
} = require('../src/services/reply-enrich-policy');
const { PENDING_CACHE_SELECT, SUPABASE_CONTACT_SELECT, assertSafeSelect } = require('../src/services/reply-contact-cache');
const { enrichProspect } = require('../src/services/prospect-enrich');
const { enrichPendingReplyPhone } = require('../src/services/reply-phone-enrichment');
const db = require('../src/db');

const REPLY_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';

function baseReply(over = {}) {
  return {
    id: REPLY_ID,
    client_id: CLIENT_ID,
    campaign_id: 'camp-1',
    lead_name: 'Pat Riley',
    lead_email: null,
    linkedin_url: 'https://linkedin.com/in/pat-riley',
    lead_phone: null,
    lead_phone_provider: null,
    lead_phone_alt: null,
    lead_website: null,
    phone_enrichment_status: null,
    phone_enrichment_error: null,
    phone_enriched_at: null,
    classification: 'QUESTION',
    status: 'pending',
    draft_reply: 'Happy to chat Tuesday.',
    enrichment_receipt: null,
    client_name: 'Acme',
    reply_enrich_ceiling_usd: null,
    reply_enrich_ceiling_hot_usd: null,
    ...over,
  };
}

function installDb(reply, { claim = true, persist } = {}) {
  const calls = [];
  const original = db.query.bind(db);
  db.query = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (/FROM pending_replies pr/.test(sql)) return { rows: [reply] };
    if (/phone_enrichment_status = 'processing'/.test(sql)) {
      if (!claim) return { rows: [] };
      return { rows: [{ ...reply }] };
    }
    if (/FROM clients/.test(sql)) return { rows: [{ id: CLIENT_ID, name: 'Acme' }] };
    if (/lead_email = COALESCE/.test(sql)) {
      const saved = persist ? persist(params) : {
        ...reply,
        lead_email: params[0],
        lead_phone: params[1],
        lead_phone_provider: params[2],
        lead_phone_alt: params[3],
        linkedin_url: params[4] || reply.linkedin_url,
        lead_website: params[5],
        enrichment_receipt: typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6],
        phone_enrichment_status: params[7],
      };
      return { rows: [saved] };
    }
    return { rows: [] };
  };
  return {
    calls,
    restore() { db.query = original; },
  };
}

function installFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    return handler(body, calls.length);
  };
  return {
    calls,
    restore() { global.fetch = original; },
  };
}

function okHit(hit) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify({ ok: true, ...hit }); },
  };
}

test('tier order is free-first then AI Ark, no LeadMagic', () => {
  assert.deepEqual([...TIER_ORDER], ['getleads', 'smartlead', 'aiark', 'prospeo', 'fullenrich']);
  assert.equal(normalizeMaxTier('leadmagic'), 'aiark');
  assert.equal(normalizeMaxTier('lm'), 'aiark');
  assert.equal(normalizeMaxTier('lead_magic'), 'aiark');
  assert.ok(allowsTier('fullenrich', 'aiark'));
  assert.ok(!allowsTier('aiark', 'prospeo'));
  assert.ok(!TIER_ORDER.includes('leadmagic'));
});

test('ceiling is $0.25 by default and $1.00 for interested / meeting-proposed', () => {
  assert.equal(DEFAULT_CEILING_USD, 0.25);
  assert.equal(HOT_CEILING_USD, 1);
  assert.deepEqual(
    resolveReplyEnrichCeiling({ classification: 'QUESTION' }),
    { ceilingUsd: 0.25, hot: false },
  );
  assert.deepEqual(
    resolveReplyEnrichCeiling({ classification: 'INTERESTED' }),
    { ceilingUsd: 1, hot: true },
  );
  assert.deepEqual(
    resolveReplyEnrichCeiling({ classification: 'MEETING_PROPOSED' }),
    { ceilingUsd: 1, hot: true },
  );
  assert.equal(
    resolveReplyEnrichCeiling({
      classification: 'QUESTION',
      client: { reply_enrich_ceiling_usd: 0.1 },
    }).ceilingUsd,
    0.1,
  );
});

test('FullEnrich mobile is only for hot replies under the hot ceiling', () => {
  assert.equal(resolvePhoneMaxTier({ classification: 'QUESTION', remainingUsd: 1 }), 'prospeo');
  assert.ok(!allowsFullEnrichMobile({ classification: 'QUESTION', remainingUsd: 1 }));
  assert.ok(allowsFullEnrichMobile({ classification: 'INTERESTED', remainingUsd: 0.55 }));
  assert.ok(!allowsFullEnrichMobile({ classification: 'INTERESTED', remainingUsd: 0.25 }));
  assert.equal(resolvePhoneMaxTier({ classification: 'MEETING_PROPOSED', remainingUsd: 1 }), 'fullenrich');
  assert.equal(resolvePhoneMaxTier({ classification: 'MEETING_PROPOSED', remainingUsd: 0.2 }), 'prospeo');
});

test('estimate-before-pay drops the cap when the walk would exceed the ceiling', () => {
  const emailWorst = estimateNeedUsd('email', 'fullenrich');
  assert.ok(emailWorst > 0 && emailWorst < 0.25);
  assert.ok(canAfford({ spentUsd: 0, nextUsd: emailWorst, ceilingUsd: 0.25 }));
  assert.ok(!canAfford({ spentUsd: 0.24, nextUsd: 0.055, ceilingUsd: 0.25 }));
  assert.equal(
    dropMaxTierToFit({ need: 'phone', maxTier: 'fullenrich', remainingUsd: 0.25 }),
    'prospeo',
  );
  assert.equal(
    dropMaxTierToFit({ need: 'phone', maxTier: 'fullenrich', remainingUsd: 1 }),
    'fullenrich',
  );
});

test('Veriphone gate accepts only valid + mobile', () => {
  assert.deepEqual(
    gateMobilePhone({ phone: '+12015550100', phone_valid: true, phone_type: 'mobile' }),
    { mobile: '+12015550100', alt: null, reason: null },
  );
  const landline = gateMobilePhone({ phone: '+12015550100', phone_valid: true, phone_type: 'landline' });
  assert.equal(landline.mobile, null);
  assert.equal(landline.alt, '+12015550100');
  assert.match(landline.reason, /not_mobile/);
  const voip = gateMobilePhone({ phone: '+12015550100', phone_valid: true, phone_type: 'voip' });
  assert.equal(voip.mobile, null);
  const invalid = gateMobilePhone({ phone: '+12015550100', phone_valid: false, phone_type: 'mobile' });
  assert.equal(invalid.mobile, null);
  assert.equal(invalid.reason, 'veriphone_invalid');
  const unconfirmed = gateMobilePhone({ phone: '+12015550100' });
  assert.equal(unconfirmed.mobile, null);
  assert.equal(unconfirmed.reason, 'veriphone_unconfirmed');
});

test('cache select never touches dl_status, sg_exclude, or skip_*', () => {
  assertSafeSelect(PENDING_CACHE_SELECT);
  assert.ok(PENDING_CACHE_SELECT.every((col) => !/dl_status|sg_exclude|^skip_/.test(col)));
  assert.doesNotMatch(SUPABASE_CONTACT_SELECT, /dl_status|sg_exclude|skip_/);
  assert.ok(FORBIDDEN_WRITE_COLUMNS.includes('dl_status'));
  const cache = read('src/services/reply-contact-cache.js');
  const job = read('src/services/reply-phone-enrichment.js');
  const pendingSql = cache.match(/`SELECT[\s\S]*?FROM pending_replies[\s\S]*?`/);
  assert.ok(pendingSql, 'pending_replies cache query must exist');
  assert.doesNotMatch(pendingSql[0], /dl_status|sg_exclude|skip_/);
  assert.match(job, /UPDATE pending_replies/);
  assert.match(job, /lead_email = COALESCE\(lead_email/);
  assert.doesNotMatch(job, /lead_email = \$1[^,]/);
  assert.doesNotMatch(job, /dl_status\s*=/);
  assert.doesNotMatch(job, /sg_exclude\s*=/);
  assert.throws(() => assertSafeSelect(['dl_status']));
  assert.throws(() => assertSafeSelect(['skip_reason']));
});

test('enrichProspect POSTs need + approve_cost_usd and never mentions LeadMagic', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test/';
  const fetch = installFetch(async () => okHit({
    email: 'jane@roofco.com',
    email_tier: 'aiark',
    spent_usd: 0.0037,
    max_tier: 'aiark',
  }));
  try {
    const hit = await enrichProspect({
      linkedinUrl: 'https://linkedin.com/in/jane',
      leadName: 'Jane Smith',
      need: 'email',
      approveCostUsd: 0.25,
      maxTier: 'leadmagic',
    });
    assert.equal(fetch.calls[0].url, 'https://waterfall.example.test/enrich-one');
    assert.equal(fetch.calls[0].body.need, 'email');
    assert.equal(fetch.calls[0].body.approve_cost_usd, 0.25);
    assert.equal(fetch.calls[0].body.max_tier, 'aiark');
    assert.equal(fetch.calls[0].body.write_supabase, false);
    assert.equal(fetch.calls[0].body.linkedin_url, 'https://linkedin.com/in/jane');
    assert.equal(hit.spentUsd, 0.0037);
    assert.doesNotMatch(JSON.stringify(fetch.calls[0].body), /leadmagic/i);
  } finally {
    fetch.restore();
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('reply enrichment is idempotent — found or processing never pays twice', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  let fetches = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    throw new Error('should not fetch');
  };

  const found = installDb(baseReply({
    phone_enrichment_status: 'found',
    lead_email: 'already@x.com',
  }));
  try {
    const a = await enrichPendingReplyPhone(REPLY_ID, {
      identityLookup: async () => { throw new Error('no cache'); },
    });
    assert.equal(a.status, 'found');
    assert.equal(fetches, 0);
    assert.ok(!found.calls.some((c) => /processing/.test(c.sql)));
  } finally {
    found.restore();
  }

  const processing = installDb(baseReply({ phone_enrichment_status: 'processing' }));
  try {
    const b = await enrichPendingReplyPhone(REPLY_ID);
    assert.equal(b.status, 'processing');
    assert.equal(fetches, 0);
  } finally {
    processing.restore();
  }

  const lostRace = installDb(baseReply(), { claim: false });
  try {
    const c = await enrichPendingReplyPhone(REPLY_ID);
    assert.equal(fetches, 0);
    assert.equal(c.status, null);
  } finally {
    lostRace.restore();
    global.fetch = originalFetch;
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('QUESTION phone walk stops at Prospeo and respects the $0.25 ceiling', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  const dbMock = installDb(baseReply({ classification: 'QUESTION' }));
  const fetch = installFetch(async (body) => {
    if (body.need === 'email') {
      return okHit({
        email: 'pat@roof.co',
        email_tier: 'getleads',
        spent_usd: 0,
        linkedin_url: 'https://linkedin.com/in/pat-riley',
      });
    }
    return okHit({
      phone: '+12015550100',
      phone_tier: 'aiark',
      phone_valid: true,
      phone_type: 'mobile',
      spent_usd: 0.0183,
    });
  });
  try {
    const result = await enrichPendingReplyPhone(REPLY_ID, {
      identityLookup: async () => ({ email: null, phone: null, website: null, linkedinUrl: null, domain: null, sources: {} }),
    });
    assert.equal(result.status, 'found');
    assert.equal(result.phone, '+12015550100');
    const needs = fetch.calls.map((c) => c.body.need);
    assert.deepEqual(needs, ['email', 'phone']);
    const phoneBody = fetch.calls.find((c) => c.body.need === 'phone').body;
    assert.equal(phoneBody.max_tier, 'prospeo');
    assert.ok(phoneBody.approve_cost_usd <= 0.25 + 1e-9);
    assert.ok(phoneBody.verify_phone);
    const persist = dbMock.calls.find((c) => /lead_email = COALESCE/.test(c.sql));
    assert.ok(persist, 'must write lead_email only via COALESCE');
    const receipt = JSON.parse(persist.params[6]);
    assert.ok(receipt.ceilingUsd <= 0.25 + 1e-9);
    assert.ok(receipt.spentUsd <= 0.25 + 1e-9);
    assert.notEqual(receipt.phoneTier, 'fullenrich');
  } finally {
    fetch.restore();
    dbMock.restore();
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('INTERESTED can request FullEnrich mobile under the $1 ceiling', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  const dbMock = installDb(baseReply({ classification: 'INTERESTED' }));
  const fetch = installFetch(async (body) => {
    if (body.need === 'email') {
      return okHit({ email: 'pat@roof.co', email_tier: 'getleads', spent_usd: 0 });
    }
    return okHit({
      phone: '+12015550100',
      phone_tier: 'fullenrich',
      phone_valid: true,
      phone_type: 'mobile',
      spent_usd: 0.55,
    });
  });
  try {
    const result = await enrichPendingReplyPhone(REPLY_ID, {
      identityLookup: async () => ({ email: null, phone: null, website: null, linkedinUrl: null, domain: null, sources: {} }),
    });
    const phoneBody = fetch.calls.find((c) => c.body.need === 'phone').body;
    assert.equal(phoneBody.max_tier, 'fullenrich');
    assert.ok(phoneBody.approve_cost_usd <= 1 + 1e-9);
    assert.ok(phoneBody.approve_cost_usd >= 0.55);
    assert.equal(result.phone, '+12015550100');
    const persist = dbMock.calls.find((c) => /lead_email = COALESCE/.test(c.sql));
    const receipt = JSON.parse(persist.params[6]);
    assert.equal(receipt.hot, true);
    assert.equal(receipt.ceilingUsd, 1);
  } finally {
    fetch.restore();
    dbMock.restore();
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('landline from the waterfall is stored as alt and does not count as a mobile', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  const dbMock = installDb(baseReply({ classification: 'INTERESTED', lead_email: 'pat@roof.co' }));
  const fetch = installFetch(async (body) => {
    assert.equal(body.need, 'phone', 'email already cached — only phone should run');
    return okHit({
      phone: '+12015550999',
      phone_tier: 'aiark',
      phone_valid: true,
      phone_type: 'landline',
      spent_usd: 0.0183,
    });
  });
  try {
    const result = await enrichPendingReplyPhone(REPLY_ID, {
      identityLookup: async () => ({ email: null, phone: null, website: null, linkedinUrl: null, domain: null, sources: {} }),
    });
    assert.equal(result.phone, null);
    assert.equal(result.phoneAlt, '+12015550999');
    const persist = dbMock.calls.find((c) => /lead_email = COALESCE/.test(c.sql));
    assert.equal(persist.params[1], null);
    assert.equal(persist.params[3], '+12015550999');
    const receipt = JSON.parse(persist.params[6]);
    assert.match(receipt.phoneGate, /not_mobile/);
  } finally {
    fetch.restore();
    dbMock.restore();
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('HeyReach webhook acks before the background enrich job and does not call LeadMagic', () => {
  const webhooks = read('src/routes/webhooks.js');
  const ackAt = webhooks.indexOf("res.status(200).json({ ok: true, accepted: true })");
  const jobAt = webhooks.indexOf('await enrichPendingReplyPhone');
  const immediateAt = webhooks.indexOf('setImmediate');
  assert.ok(ackAt !== -1 && jobAt !== -1 && immediateAt !== -1);
  assert.ok(ackAt < immediateAt, 'HeyReach must ack before setImmediate');
  assert.ok(immediateAt < jobAt, 'enrichment must run inside the background job');
  assert.doesNotMatch(webhooks, /leadmagic|profileToEmail|LEADMAGIC/i);
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/services/leadmagic.js')));
});

test('reply enrichment is idempotent, ceiling-capped, Veriphone-gated', () => {
  assert.equal(DEFAULT_CEILING_USD, 0.25);
  assert.equal(HOT_CEILING_USD, 1);
  assert.equal(resolvePhoneMaxTier({ classification: 'QUESTION', remainingUsd: 1 }), 'prospeo');
  assert.equal(
    gateMobilePhone({ phone: '+12015550100', phone_valid: true, phone_type: 'landline' }).mobile,
    null,
  );
  const job = read('src/services/reply-phone-enrichment.js');
  assert.match(job, /phone_enrichment_status = 'processing'/);
  assert.match(job, /approveCostUsd/);
  assert.match(job, /gateMobilePhone/);
  assert.doesNotMatch(job, /leadmagic/i);
});

test('enrichment logs do not print lead rows', () => {
  const job = read('src/services/reply-phone-enrichment.js');
  assert.match(job, /\[ReplyEnrich\]/);
  assert.doesNotMatch(job, /phone:\s*enriched/);
  assert.doesNotMatch(job, /email:\s*leadEmail/);
  assert.doesNotMatch(job, /console\.log\([^\)]*lead_email/);
  assert.doesNotMatch(job, /console\.log\([^\)]*linkedinUrl/);
});
