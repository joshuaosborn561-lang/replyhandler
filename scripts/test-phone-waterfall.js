#!/usr/bin/env node

const assert = require('assert');
const getleads = require('../src/services/getleads');
const aiark = require('../src/services/aiark');
const leadmagic = require('../src/services/leadmagic');
const { enrichProspect } = require('../src/services/prospect-enrich');

const originals = {
  getleads: { ...getleads },
  aiark: { ...aiark },
  leadmagic: { ...leadmagic },
};

async function main() {
  const calls = [];
  getleads.isConfigured = () => true;
  getleads.findPhoneByEmail = async () => {
    calls.push('getleads');
    return {
      phone: null,
      linkedinUrl: 'https://linkedin.com/in/test',
      website: 'example.com',
    };
  };
  getleads.linkedinFromEmail = async () => {
    calls.push('getleads-linkedin');
    return null;
  };
  aiark.isConfigured = () => true;
  aiark.reverseLookupByEmail = async () => {
    calls.push('aiark-reverse');
    return { linkedinUrl: null, website: null };
  };
  aiark.findMobile = async () => {
    calls.push('aiark');
    return { phone: null };
  };
  leadmagic.isMobileFinderConfigured = () => true;
  leadmagic.findMobile = async () => {
    calls.push('leadmagic');
    return { phone: '+1 555-0100' };
  };

  const result = await enrichProspect({
    email: 'person@example.com',
    leadName: 'Test Person',
  });

  assert.deepStrictEqual(calls, ['getleads', 'aiark-reverse', 'aiark', 'leadmagic']);
  assert.strictEqual(result.phone, '+1 555-0100');
  assert.strictEqual(result.sources.phone, 'leadmagic');
  assert.strictEqual(result.linkedinUrl, 'https://linkedin.com/in/test');
  assert.strictEqual(result.website, 'https://example.com');

  calls.length = 0;
  getleads.findPhoneByEmail = async () => {
    calls.push('getleads');
    return { phone: '+1 555-0199', linkedinUrl: null, website: null };
  };

  const firstHit = await enrichProspect({ email: 'first@example.com' });
  assert.deepStrictEqual(calls, ['getleads']);
  assert.strictEqual(firstHit.phone, '+1 555-0199');
  assert.strictEqual(firstHit.sources.phone, 'getleads');

  console.log('ok — GetLeads → AI Ark → LeadMagic phone waterfall');
}

main()
  .finally(() => {
    Object.assign(getleads, originals.getleads);
    Object.assign(aiark, originals.aiark);
    Object.assign(leadmagic, originals.leadmagic);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
