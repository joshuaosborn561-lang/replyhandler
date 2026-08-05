const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveWebsite,
  extractPageSignals,
  heuristicSummary,
  isFreeEmailDomain,
  formatProspectDescriptionLine,
} = require('../src/services/prospect-description');

describe('prospect-description', () => {
  it('uses corporate email domain as website', () => {
    const r = resolveWebsite({ email: 'chris@capmri.com' });
    assert.equal(r.website, 'https://capmri.com');
    assert.equal(r.source, 'email_domain');
  });

  it('skips free email domains', () => {
    assert.ok(isFreeEmailDomain('gmail.com'));
    const r = resolveWebsite({ email: 'bob@gmail.com' });
    assert.equal(r.website, null);
    assert.equal(r.freeEmail, true);
  });

  it('prefers stored lead_website over email domain', () => {
    const r = resolveWebsite({
      email: 'chris@capmri.com',
      website: 'https://www.example-roofs.com',
    });
    assert.equal(r.website, 'https://www.example-roofs.com');
    assert.equal(r.source, 'lead_website');
  });

  it('extracts title and meta description from HTML', () => {
    const html = `
      <html><head>
        <title>Bay Area Roofing Co</title>
        <meta name="description" content="We install and repair commercial roofs in Tampa." />
        <meta property="og:site_name" content="Bay Area Roofing" />
      </head><body><p>Trusted roofing contractor since 1998.</p></body></html>
    `;
    const s = extractPageSignals(html);
    assert.match(s.title, /Bay Area Roofing/);
    assert.match(s.description, /commercial roofs/i);
    assert.equal(s.siteName, 'Bay Area Roofing');
  });

  it('builds a category + one-liner from page signals', () => {
    const summary = heuristicSummary({
      signals: {
        title: 'Bay Area Roofing',
        description: 'Commercial and residential roofing across Tampa Bay.',
        siteName: 'Bay Area Roofing',
        bodySample: 'We are a roofing contractor.',
      },
      domain: 'bayarearoofing.com',
    });
    assert.equal(summary.category, 'Roofing');
    assert.match(summary.description, /Roofing/);
    assert.match(summary.description, /roofing/i);
  });

  it('formats the Slack line from description', () => {
    assert.equal(
      formatProspectDescriptionLine({
        description: 'Roofing. Bay Area Roofing installs commercial roofs.',
      }),
      'Roofing. Bay Area Roofing installs commercial roofs.'
    );
  });
});
