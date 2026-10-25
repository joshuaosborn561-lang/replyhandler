const test = require('node:test');
const assert = require('node:assert');
const { findLinkedin, scoreCandidate } = require('../src/services/linkedin-finder');

const lead = { leadName: 'Pat Baker', domain: 'roofco.com', companyName: 'Roof Co' };

test('right person at the right company scores high', () => {
  const s = scoreCandidate(lead, { linkedinUrl: 'https://www.linkedin.com/in/pat-baker-1', fullName: 'Pat Baker', title: 'Owner at Roof Co' });
  assert.ok(s >= 0.85, String(s));
});

test('wrong last name is review even at the right company', () => {
  const s = scoreCandidate(lead, { linkedinUrl: 'https://www.linkedin.com/in/pat-smith', fullName: 'Pat Smith', title: 'Owner at Roof Co' });
  assert.ok(s < 0.7, String(s));
});

test('falls back from GetLeads miss to profile lookup', async () => {
  const out = await findLinkedin({ leadName: 'Pat Baker', email: 'pat@roofco.com' }, {
    getleadsApi: { isConfigured: () => true, linkedinFromEmail: async () => null },
    profileLookup: async () => ({ linkedinUrl: 'https://www.linkedin.com/in/patbaker', fullName: 'Pat Baker', title: 'Owner - Roofco', sources: { linkedin: 'serper' } }),
  });
  assert.equal(out.linkedinUrl, 'https://www.linkedin.com/in/patbaker');
  assert.notEqual(out.confidence, 'review');
  assert.deepEqual(out.tried, ['getleads', 'aiark+serper']);
});
