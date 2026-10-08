const test = require('node:test');
const assert = require('node:assert');
const { extractLinkedinUrl, normalizeLinkedinUrl } = require('../src/utils/linkedin-url');

test('extractLinkedinUrl reads SmartLead linkedin_profile', () => {
  const url = extractLinkedinUrl({
    first_name: 'Ed',
    email: 'ed@elmwoodcustomhomes.com',
    linkedin_profile: 'linkedin.com/in/ed-merkel-184a9011b',
  });
  assert.strictEqual(url, 'https://linkedin.com/in/ed-merkel-184a9011b');
});

test('extractLinkedinUrl reads custom_fields and ignores sports team', () => {
  const url = extractLinkedinUrl({
    custom_fields: {
      Local_Sports_Team: 'Warriors',
      LinkedIn_URL: 'https://www.linkedin.com/in/pat-riley',
    },
  });
  assert.strictEqual(url, 'https://www.linkedin.com/in/pat-riley');
});

test('extractLinkedinUrl walks webhook payload.lead_data', () => {
  const url = extractLinkedinUrl(
    { event: 'EMAIL_REPLY' },
    { email: 'pat@example.com', linkedin_profile: 'https://www.linkedin.com/in/pat-riley' },
  );
  assert.strictEqual(url, 'https://www.linkedin.com/in/pat-riley');
});

test('normalizeLinkedinUrl rejects non-LinkedIn URLs', () => {
  assert.strictEqual(normalizeLinkedinUrl('https://example.com/pat'), '');
  assert.strictEqual(extractLinkedinUrl({ website: 'https://roofco.com' }), null);
});
