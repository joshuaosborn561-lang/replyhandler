const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { promoteReferral } = require('../src/routes/webhooks');
const {
  shouldRecoverSuppressedReferral,
} = require('../src/utils/referral-promotion');
const {
  extractReferredContacts,
  referralDraftText,
} = require('../src/utils/referred-contact');
const { slackSuppressionReason } = require('../src/utils/smartlead-webhook-helpers');
const { refreshReferralDrafts } = require('../src/services/refresh-referral-draft');
const { ensureArielReferralCard, ARIEL_MESSAGE_ID } = require('../src/services/ariel-referral-card');

const OPTS = {
  prospectEmail: 'sender@example.com',
  prospectName: 'Sender',
  ourEmails: ['gracev@vectorenergyrun.info'],
};

const ARIEL = 'Hi please talk to Guy at our office. Guy@orioncityscape.com';
const ARIEL_OPTS = {
  prospectEmail: 'ariel@orioncityscape.com',
  prospectName: 'Ariel Isaac Franco',
  ourEmails: ['gracev@vectorenergyrun.info'],
};

const DON = 'Please contact Greg Goodwin or Steve Schofield. zip@goodwin-schofield.com';
const DON_OPTS = {
  prospectEmail: 'don.smith@example.com',
  prospectName: 'Don Smith',
  ourEmails: ['gracev@vectorenergyrun.info'],
};

const BLOCKED = [
  ['Wayne Klinger', 'This inbox is not regularly monitored. Please contact wayne.new@example.com'],
  ['John Davis', 'This email is not regularly monitored. Contact john.new@example.com'],
  ['Irene Amaro', 'This mailbox is no longer monitored. Please contact irene.new@example.com'],
  ['Evan Glassman', 'This email address is no longer active. Please contact evan.new@example.com'],
  ['Katrina Flesher', 'This inbox is no longer active. Contact katrina.new@example.com'],
  ['Frank Bonanno', 'This mailbox is no longer in use. Please contact frank.new@example.com'],
  ['Andrew Murray', 'This email is no longer in use. Contact andrew.new@example.com'],
  ['Christopher Hallmeyer', 'This address is not monitored. Please contact chris.new@example.com'],
  ['Ricardo Polmon', 'Ricardo is no longer part of the team. Please contact ricardo.new@example.com'],
  ['Bob Reilly', 'Bob Reilly is no longer a sales representative. Please contact bob.new@example.com'],
  ['James Wyman', 'I will forward your email to mb-thompson@example.com'],
  ['Courtney Franklin', 'Writing on behalf of Courtney Franklin. We are not seeking any new partnerships. fersosa@example.com'],
  ['retired', 'I have retired from the company. Please contact successor@example.com'],
  ['moved on', "I've moved on from the team. Please contact next.person@example.com"],
  ['left', 'I left the company. Please contact replacements@example.com'],
  ['leaving and not the right person', 'I am not the right person and I am leaving the company. Please contact other@example.com'],
];

function noCard(body, opts = OPTS) {
  const ref = promoteReferral('NOT_INTERESTED', body, opts);
  assert.equal(ref.promoted, false, body);
  assert.deepEqual(ref.referredContacts, [], body);
  assert.equal(referralDraftText({
    leadName: 'Prospect',
    inboundMessage: body,
    ...opts,
  }), '', body);
  assert.deepEqual(extractReferredContacts(body, opts), [], body);
  assert.equal(shouldRecoverSuppressedReferral({
    classification: 'NOT_INTERESTED',
    suppressionReason: 'not_interested',
    smartleadClassification: 'NOT_INTERESTED',
    inbound: body,
  }), false, body);
  assert.ok(slackSuppressionReason(body), body);
}

describe('a left-the-company email is not a referral', () => {
  for (const [who, body] of BLOCKED) {
    it(`${who} produces no card, no CC, and no referral draft`, () => {
      noCard(body);
    });
  }

  it('does not CC the sender or greet Fersosa on a no sent on their behalf', () => {
    const body = 'Writing on behalf of Courtney Franklin. We are not seeking any new partnerships. fersosa@example.com';
    const opts = { ...OPTS, prospectEmail: 'fersosa@example.com', prospectName: 'Fernanda' };
    noCard(body, opts);
    const draft = referralDraftText({
      leadName: 'Fernanda',
      inboundMessage: body,
      referredContacts: [{ name: 'Fersosa', email: 'fersosa@example.com' }],
      ...opts,
    });
    assert.equal(draft, '');
    assert.deepEqual(extractReferredContacts(
      'Please talk to Guy at fersosa@example.com',
      { prospectEmail: 'fersosa@example.com' },
    ), []);
  });

  it('a Not Interested label is not recovered unless the human text is a current-employee handoff', () => {
    assert.equal(shouldRecoverSuppressedReferral({
      classification: 'OTHER',
      smartleadClassification: 'NOT_INTERESTED',
      inbound: 'Thanks, my email is replacement@example.com',
    }), false);
    assert.equal(promoteReferral(
      'NOT_INTERESTED',
      'Thanks, my email is replacement@example.com',
      OPTS,
    ).promoted, false);
  });

  it('Ariel still gets the referral card from Not Interested', () => {
    const ref = promoteReferral('NOT_INTERESTED', ARIEL, ARIEL_OPTS);
    assert.equal(ref.promoted, true);
    assert.equal(ref.classification, 'INTERESTED');
    assert.equal(ref.referredContacts[0].email, 'Guy@orioncityscape.com');
    assert.equal(shouldRecoverSuppressedReferral({
      classification: 'NOT_INTERESTED',
      suppressionReason: 'not_interested',
      smartleadClassification: 'NOT_INTERESTED',
      inbound: ARIEL,
    }), true);
    const draft = referralDraftText({
      leadName: 'Ariel Isaac Franco',
      inboundMessage: ARIEL,
      ...ARIEL_OPTS,
    });
    assert.equal(draft, 'Thank you so much for the contact, Ariel!\n\nHey Guy, would this be worth meeting about for you?');
    assert.doesNotMatch(draft, /Ariel@/);
  });

  it('Don Smith is still a real referral, greeted as Greg', () => {
    const ref = promoteReferral('NOT_INTERESTED', DON, DON_OPTS);
    assert.equal(ref.promoted, true);
    assert.equal(ref.referredContacts[0].email, 'zip@goodwin-schofield.com');
    assert.equal(shouldRecoverSuppressedReferral({
      classification: 'NOT_INTERESTED',
      suppressionReason: 'not_interested',
      smartleadClassification: 'NOT_INTERESTED',
      inbound: DON,
    }), true);
    const draft = referralDraftText({
      leadName: 'Don Smith',
      inboundMessage: DON,
      ...DON_OPTS,
    });
    assert.match(draft, /Hey Greg, would this be worth meeting about for you\?/);
    assert.doesNotMatch(draft, /Hey Zip/);
    assert.doesNotMatch(draft, /don\.smith@example\.com/i);
  });

  it('a role or company local part is Hey there, not a first name', () => {
    const locals = [
      ['ar@vendor.com', /Hey Ar/],
      ['info@vendor.com', /Hey Info/],
      ['sales@vendor.com', /Hey Sales/],
      ['estimating@vendor.com', /Hey Estimating/],
      ['accounting@vendor.com', /Hey Accounting/],
      ['paragon@paragon.com', /Hey Paragon/],
    ];
    for (const [email, banned] of locals) {
      const body = `Please contact them at ${email}`;
      const draft = referralDraftText({
        leadName: 'Ariel Isaac Franco',
        inboundMessage: body,
        prospectEmail: 'ariel@orioncityscape.com',
      });
      assert.match(draft, /Hey there, would this be worth meeting about for you\?/, email);
      assert.doesNotMatch(draft, banned, email);
    }
  });

  it('recovery still asks before it promotes, and does not insert a second row', () => {
    const sl = fs.readFileSync(path.join(__dirname, '..', 'src/services/smartlead-poller.js'), 'utf8');
    const fn = sl.slice(
      sl.indexOf('async function recoverSuppressedReferral'),
      sl.indexOf('async function returnPostedOrRecoverReferral'),
    );
    assert.ok(fn.indexOf('shouldRecoverSuppressedReferral') < fn.indexOf('promoteReferral('));
    assert.doesNotMatch(fn, /claimNewInbound/);
    assert.doesNotMatch(fn, /INSERT INTO pending_replies/);
  });
});

describe('Ariel gets one card on deploy', () => {
  const row = {
    id: 'ariel-row',
    lead_email: 'ariel@orioncityscape.com',
    campaign_id: '4242292',
    inbound_message_id: ARIEL_MESSAGE_ID,
    slack_message_ts: null,
    status: 'suppressed',
    classification: 'NOT_INTERESTED',
    lead_name: 'Ariel Isaac Franco',
    inbound_message: ARIEL,
    created_at: '2026-10-27T14:57:10Z',
  };

  it('posts exactly one card when she has none', async () => {
    const calls = [];
    const out = await ensureArielReferralCard({
      query: async () => ({ rows: [row] }),
      refresh: async (args) => {
        calls.push(args);
        return { posted: 1, rows: [{ action: 'posted', replyId: row.id }] };
      },
    });
    assert.equal(out.action, 'posted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dry, false);
    assert.equal(calls[0].missingOnly, true);
    assert.equal(calls[0].leadEmail, 'ariel@orioncityscape.com');
    assert.equal(calls[0].campaignId, '4242292');
    assert.equal(calls[0].replyId, 'ariel-row');
  });

  it('does nothing when a card or a send already exists', async () => {
    let calls = 0;
    const refresh = async () => { calls += 1; return { posted: 1, rows: [{ action: 'posted' }] }; };
    const posted = await ensureArielReferralCard({
      query: async () => ({ rows: [{ ...row, slack_message_ts: '1761570000.000100' }] }),
      refresh,
    });
    const sent = await ensureArielReferralCard({
      query: async () => ({ rows: [{ ...row, status: 'sent' }] }),
      refresh,
    });
    const missing = await ensureArielReferralCard({
      query: async () => ({ rows: [] }),
      refresh,
    });
    assert.equal(posted.action, 'already_posted');
    assert.equal(sent.action, 'already_posted');
    assert.equal(missing.action, 'no_row');
    assert.equal(calls, 0);
  });

  it('a missing-only refresh does not chat.update an existing card', async () => {
    const updates = [];
    const posts = [];
    const result = await refreshReferralDrafts({
      dry: false,
      missingOnly: true,
      leadEmail: 'ariel@orioncityscape.com',
      replyId: row.id,
      query: async () => ({ rows: [{ ...row, slack_message_ts: '1761570000.000100', status: 'pending' }] }),
      saveDraft: async () => { throw new Error('should not write'); },
      updateCard: async () => { updates.push(1); },
      postCard: async () => { posts.push(1); return { ts: 'new' }; },
    });
    assert.equal(updates.length, 0);
    assert.equal(posts.length, 0);
    assert.equal(result.rows[0].action, 'skip');
    assert.equal(result.rows[0].reason, 'card_already_exists');
  });

  it('startup calls the one-shot and the one-shot does not send', () => {
    const cron = fs.readFileSync(path.join(__dirname, '..', 'src/cron.js'), 'utf8');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/ariel-referral-card.js'), 'utf8');
    assert.match(cron, /ensureArielReferralCard/);
    assert.doesNotMatch(src, /sendReply/);
    assert.match(src, /missingOnly: true/);
    assert.match(src, /ariel@orioncityscape.com/);
    assert.match(src, /4242292/);
  });
});
