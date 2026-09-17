const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClientNotifyEmail,
  normalizeThreadSteps,
} = require('../src/services/client-notify-email');

const HISTORY = {
  history: [
    {
      type: 'SENT',
      time: '2026-09-17T16:22:37.211Z',
      from: 'matthew.carter4@roofsbypetersonget.info',
      to: 'shelby@sbpcommercial.com',
      subject: 'RE: Rangers tix',
      email_body: '<div>Shelby, that offer\'s still good.</div>',
    },
    {
      type: 'REPLY',
      time: '2026-09-17T18:45:18.000Z',
      from: 'ashton.young@sbpcommercial.com',
      to: 'matthew.carter4@roofsbypetersonget.info',
      subject: null,
      email_body: '<p>Hi Matthew — Which location?</p>',
    },
  ],
};

describe('client notify thread format', () => {
  it('renders From/To/Subject cards instead of Us/Prospect labels', () => {
    const steps = normalizeThreadSteps(HISTORY, {
      leadName: 'Shelby',
      leadEmail: 'shelby@sbpcommercial.com',
      sentText: 'Hey Shelby, glad to hear you\'re open to it!',
    });

    assert.equal(steps.length, 3);
    assert.equal(steps[0].from, 'matthew.carter4@roofsbypetersonget.info');
    assert.equal(steps[0].to, 'shelby@sbpcommercial.com');
    assert.equal(steps[0].subject, 'RE: Rangers tix');
    assert.match(steps[0].status, /Email sent/);

    // Colleague reply keeps their address — not forced to lead name.
    assert.equal(steps[1].from, 'ashton.young@sbpcommercial.com');
    assert.equal(steps[1].to, 'matthew.carter4@roofsbypetersonget.info');
    assert.match(steps[1].status, /Replied/);

    assert.equal(steps[2].direction, 'just_sent');
    assert.equal(steps[2].from, 'matthew.carter4@roofsbypetersonget.info');
    assert.equal(steps[2].to, 'shelby@sbpcommercial.com');
    assert.match(steps[2].status, /You replied/);
    assert.match(steps[2].body, /glad to hear/i);
  });

  it('HTML body looks like an inbox thread', () => {
    const { htmlBody, textBody } = buildClientNotifyEmail({
      leadName: 'Shelby',
      leadEmail: 'shelby@sbpcommercial.com',
      clientName: 'Roofs By Peterson',
      campaignName: 'Peterson - C3 Churches - SPORTS - SEG',
      enrichment: { email: 'shelby@sbpcommercial.com', phone: null },
      threadContext: HISTORY,
      inboundMessage: 'Hi Matthew — Which location?',
      sentText: 'Hey Shelby, glad to hear you\'re open to it!',
    });

    assert.match(htmlBody, /From:/);
    assert.match(htmlBody, /To:/);
    assert.match(htmlBody, /RE: Rangers tix/);
    assert.match(htmlBody, /ashton\.young@sbpcommercial\.com/);
    assert.doesNotMatch(htmlBody, /Us \(just sent\)/);
    assert.doesNotMatch(htmlBody, />Us</);
    assert.match(textBody, /From: matthew\.carter4@roofsbypetersonget\.info/);
    assert.match(textBody, /To: shelby@sbpcommercial\.com/);
  });

  it('prefixes lead name when From matches lead email', () => {
    const steps = normalizeThreadSteps({
      history: [{
        type: 'REPLY',
        from: 'shelby@sbpcommercial.com',
        to: 'matthew.carter4@roofsbypetersonget.info',
        email_body: 'Sure',
        time: '2026-09-17T18:00:00.000Z',
      }],
    }, {
      leadName: 'Shelby',
      leadEmail: 'shelby@sbpcommercial.com',
    });
    assert.equal(steps[0].from, 'Shelby shelby@sbpcommercial.com');
  });
});
