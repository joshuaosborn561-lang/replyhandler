const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSignatureBlocks,
  foreignBrandInSignature,
  signatureMatchesClient,
} = require('../src/services/smartlead-sender-guard');

describe('smartlead sender guard — signature extraction', () => {
  it('pulls Name\\nCompany from SmartLead HTML', () => {
    const html = (
      `<div>Sean, that offer's still open whenever you want it.</div>` +
      `<div><br></div>` +
      `<div>open to it?</div>` +
      `<div><br></div>` +
      `<div>Aarav Sanchez\nRoofs by Peterson</div>` +
      `<div><br></div>` +
      `<div>Not for you? One reply and you won't hear from me again.</div>`
    );
    const blocks = extractSignatureBlocks(html);
    assert.ok(blocks.some((b) => /Aarav Sanchez/.test(b) && /Roofs by Peterson/.test(b)));
  });
});

describe('smartlead sender guard — foreign brand detection', () => {
  it('flags Peterson signature on a Goliath send (Sean Dean incident)', () => {
    const sig = 'Aarav Sanchez\nRoofs by Peterson';
    assert.equal(foreignBrandInSignature(sig, 'Goliath'), 'Roofs By Peterson');
    assert.equal(signatureMatchesClient(sig, 'Goliath').ok, false);
  });

  it('flags Culture Fits signature on a Goliath send', () => {
    const sig = 'Grace Mensah\nCulture Fits';
    assert.equal(foreignBrandInSignature(sig, 'Goliath'), 'Culture Fits');
  });

  it('allows a real Goliath signature', () => {
    const sig = 'Daisy Wagner\nGoliath Cybersecurity';
    assert.equal(foreignBrandInSignature(sig, 'Goliath'), null);
    assert.equal(signatureMatchesClient(sig, 'Goliath').ok, true);
  });

  it('allows Peterson signature on Peterson campaigns', () => {
    const sig = 'Aarav Sanchez\nRoofs by Peterson';
    assert.equal(foreignBrandInSignature(sig, 'Roofs By Peterson'), null);
    assert.equal(signatureMatchesClient(sig, 'Roofs By Peterson').ok, true);
  });
});
