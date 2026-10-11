const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveLinksFromFields,
  resolveCardIdentity,
  lookupMissingLinkedin,
  pickLinkedin,
  pickWebsite,
  websiteFromEmail,
  isConsumerHost,
  linkLookupCeilingUsd,
} = require('../src/services/reply-card-identity');
const { estimateNeedUsd, dropMaxTierToFit } = require('../src/services/reply-enrich-policy');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('picks LinkedIn from Smartlead custom fields and HeyReach profile URL', () => {
  assert.equal(
    pickLinkedin({ custom_fields: { linkedin_url: 'linkedin.com/in/pat' } }),
    'https://linkedin.com/in/pat',
  );
  assert.equal(
    pickLinkedin({ profileUrl: 'https://www.linkedin.com/in/casey' }),
    'https://www.linkedin.com/in/casey',
  );
  assert.equal(pickLinkedin({ website: 'https://acme.com' }), null);
});

test('website comes from company domain, never gmail/outlook', () => {
  assert.equal(pickWebsite({ website: 'acme.com' }), 'https://acme.com');
  assert.equal(pickWebsite({ website: 'https://gmail.com' }), null);
  assert.equal(websiteFromEmail('pat@acme.com'), 'https://acme.com');
  assert.equal(websiteFromEmail('pat@gmail.com'), null);
  assert.equal(websiteFromEmail('pat@outlook.com'), null);
  assert.ok(isConsumerHost('https://yahoo.com'));
});

test('resolveLinksFromFields is sync and prefers lead fields over email domain', () => {
  const hit = resolveLinksFromFields({
    card: {
      leadEmail: 'pat@acme.com',
      leadLinkedinUrl: 'https://linkedin.com/in/pat',
      leadWebsite: 'https://acme.com',
    },
  });
  assert.equal(hit.linkedinUrl, 'https://linkedin.com/in/pat');
  assert.equal(hit.website, 'https://acme.com');
  assert.equal(hit.email, 'pat@acme.com');

  const fromEmail = resolveLinksFromFields({
    card: { leadEmail: 'casey@steelco.io' },
  });
  assert.equal(fromEmail.linkedinUrl, null);
  assert.equal(fromEmail.website, 'https://steelco.io');
});

test('resolveCardIdentity fills LinkedIn from the contact cache by email', async () => {
  const identity = await resolveCardIdentity({
    card: { leadEmail: 'pat@acme.com', leadName: 'Pat' },
    db: {},
    identityLookup: async () => ({
      email: 'pat@acme.com',
      linkedinUrl: 'https://linkedin.com/in/pat-riley',
      website: null,
      domain: 'acme.com',
      sources: { linkedin: 'name_bank' },
    }),
  });
  assert.equal(identity.linkedinUrl, 'https://linkedin.com/in/pat-riley');
  assert.equal(identity.website, 'https://acme.com');
  assert.equal(identity.sources.linkedin, 'name_bank');
});

test('paid LinkedIn lookup estimates first and stays under the $0.05 ceiling', async () => {
  assert.equal(linkLookupCeilingUsd(), 0.05);
  const fitted = dropMaxTierToFit({ need: 'email', maxTier: 'prospeo', remainingUsd: 0.05 });
  assert.ok(fitted);
  assert.ok(estimateNeedUsd('email', fitted) <= 0.05 + 1e-9);
  assert.ok(estimateNeedUsd('email', 'fullenrich') > 0.05);

  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      text: async () => JSON.stringify({
        email: 'pat@acme.com',
        linkedin_url: 'https://linkedin.com/in/pat',
        website: 'https://acme.com',
        spent_usd: 0.0037,
        sources: { linkedin: 'aiark' },
      }),
    };
  };
  const prevUrl = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.test';
  try {
    const hit = await lookupMissingLinkedin({
      email: 'pat@acme.com',
      leadName: 'Pat Riley',
      ceilingUsd: 0.05,
    });
    assert.equal(hit.linkedinUrl, 'https://linkedin.com/in/pat');
    assert.equal(calls[0].body.need, 'email');
    assert.ok(calls[0].body.max_tier !== 'fullenrich');
    assert.equal(calls[0].body.approve_cost_usd, 0.05);
    assert.equal(calls[0].body.write_supabase, false);
  } finally {
    global.fetch = prevFetch;
    if (prevUrl == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prevUrl;
  }
});

test('card identity never writes dl_status / sg_exclude / skip_*', () => {
  const identity = read('src/services/reply-card-identity.js');
  const cache = read('src/services/reply-contact-cache.js');
  const poster = read('src/services/slack-reply-post.js');
  for (const src of [identity, cache, poster]) {
    assert.doesNotMatch(src, /SET[^;]*dl_status/i);
    assert.doesNotMatch(src, /SET[^;]*sg_exclude/i);
    assert.doesNotMatch(src, /SET[^;]*skip_/i);
    assert.doesNotMatch(src, /UPDATE[^;]*dl_status/i);
  }
  assert.match(poster, /linkedin_url = COALESCE/);
  assert.match(poster, /lead_website = COALESCE/);
});
