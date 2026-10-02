const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClientNotifyEmail,
  normalizeThreadSteps,
  pickRicherThreadContext,
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

  it('keeps the full thread, not a 12-message tail', () => {
    const history = {
      history: Array.from({ length: 14 }, (_, i) => ({
        type: 'SENT',
        time: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
        from: 'us@example.com',
        to: 'lead@example.com',
        subject: 'AirPods',
        email_body: `<p>Sequence email ${i + 1}</p>`,
      })),
    };
    history.history.push({
      type: 'REPLY',
      time: '2026-09-30T20:29:56.000Z',
      from: 'lead@example.com',
      to: 'us@example.com',
      email_body: '<p>Were are you guys out of?</p>',
    });
    const steps = normalizeThreadSteps(history, {
      leadName: 'Cory Schell',
      leadEmail: 'lead@example.com',
      sentText: 'Hey Cory, still interested in meeting for this?',
    });
    assert.ok(steps.length >= 15, `expected full thread, got ${steps.length}`);
    assert.match(steps[0].body, /Sequence email 1/);
    assert.match(steps[steps.length - 1].body, /still interested/i);
  });

  it('merges a prior approved send missing from the stored snapshot', () => {
    const stored = {
      history: [
        {
          type: 'SENT',
          time: '2026-09-30T19:22:35.728Z',
          from: 'ethan.croft@emcorget.info',
          to: 'cory@thekellycompany.com',
          subject: 'AirPods for you',
          email_body: '<p>Cory, I\'ve got an extra pair of AirPods</p>',
        },
        {
          type: 'REPLY',
          time: '2026-09-30T20:29:56.000Z',
          from: 'cory@thekellycompany.com',
          to: 'ethan.croft@emcorget.info',
          email_body: '<p>Were are you guys out of?</p>',
        },
      ],
    };
    const steps = normalizeThreadSteps(stored, {
      leadName: 'Cory Schell',
      leadEmail: 'cory@thekellycompany.com',
      extraMessages: [{
        type: 'SENT',
        time: '2026-10-01T12:39:22.000Z',
        email_body: 'Good question! We\'re based out of West Sacramento.',
      }],
      sentText: 'Hey Cory, still interested in meeting for this?',
    });
    const bodies = steps.map((s) => s.body).join('\n---\n');
    assert.match(bodies, /extra pair of AirPods/);
    assert.match(bodies, /West Sacramento/);
    assert.match(bodies, /still interested/);
    assert.equal(steps.filter((s) => /West Sacramento/.test(s.body)).length, 1);
  });

  it('strips leftover CSS from inbound HTML', () => {
    const steps = normalizeThreadSteps({
      history: [{
        type: 'REPLY',
        from: 'cory@thekellycompany.com',
        to: 'ethan.croft@emcorget.info',
        email_body: '<style>P {margin-top:0;margin-bottom:0;}</style><p>Hello Ethan,</p><p>Were are you guys out of?</p>',
        time: '2026-09-30T20:29:56.000Z',
      }],
    }, { leadName: 'Cory Schell', leadEmail: 'cory@thekellycompany.com' });
    assert.match(steps[0].body, /Were are you guys out of/);
    assert.doesNotMatch(steps[0].body, /margin-top/);
  });

  it('does not duplicate sentText already in live history', () => {
    const steps = normalizeThreadSteps({
      history: [{
        type: 'SENT',
        from: 'us@example.com',
        to: 'lead@example.com',
        email_body: 'Hey Cory, still interested in meeting for this?',
        time: '2026-10-01T14:43:53.000Z',
      }],
    }, { sentText: 'Hey Cory, still interested in meeting for this?' });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].direction, 'just_sent');
  });
});

describe('pickRicherThreadContext', () => {
  it('prefers live SmartLead history over a thin inbound snapshot', () => {
    const stored = { history: [{ type: 'SENT', email_body: 'old' }] };
    const live = {
      history: [
        { type: 'SENT', email_body: 'old' },
        { type: 'REPLY', email_body: 'inbound' },
        { type: 'SENT', email_body: 'first approved reply' },
      ],
    };
    const picked = pickRicherThreadContext(live, stored);
    assert.equal(picked, live);
  });

  it('falls back to stored context when live fetch is empty', () => {
    const stored = { history: [{ type: 'SENT', email_body: 'old' }] };
    assert.equal(pickRicherThreadContext({ history: [] }, stored), stored);
    assert.equal(pickRicherThreadContext(null, stored), stored);
  });
});
