const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const { draftOnly, stripSignOff, fallbackDraftText } = require('../src/services/classifier');
const { buildDraftApprovalCard } = require('../src/services/slack');
const {
  referralDraftText,
  extractReferredContacts,
} = require('../src/utils/referred-contact');
const {
  planReferralCardActions,
  refreshReferralDrafts,
  cardPayload,
} = require('../src/services/refresh-referral-draft');

const ARIEL = 'Thank you so much for the contact, Ariel!\n\nHey Guy, would this be worth meeting about for you?';
const ARIEL_BODY = 'Hi please talk to Guy at our office. Guy@orioncityscape.com';
const OPTS = {
  prospectEmail: 'ariel@orioncityscape.com',
  prospectName: 'Ariel Isaac Franco',
  ourEmails: ['gracev@vectorenergyrun.info'],
};

function arielRow(extra = {}) {
  return {
    id: 'ariel-row',
    status: 'pending',
    classification: 'INTERESTED',
    platform: 'smartlead',
    lead_name: 'Ariel Isaac Franco',
    lead_email: 'ariel@orioncityscape.com',
    campaign_id: '4242292',
    campaign_name: 'Vector | Big Owners | Clippers',
    inbound_message: ARIEL_BODY,
    inbound_message_id: '<ariel-msg@mail.gmail.com>',
    slack_message_ts: '1761570000.000100',
    slack_channel_id: 'C0CC420V1TK',
    slack_bot_token: 'xoxb-test',
    client_id: 'vector',
    created_at: '2026-10-27T14:57:10Z',
    draft_reply: 'Hey Ariel, thanks for pointing me to Guy. Happy to jump on a quick call.',
    ...extra,
  };
}

describe('referral drafts use the fixed template', () => {
  it('Ariel and Guy are the exact two lines', () => {
    assert.equal(referralDraftText({
      leadName: 'Ariel Isaac Franco',
      inboundMessage: ARIEL_BODY,
      ...OPTS,
    }), ARIEL);
  });

  it('talk to Guy with no email still addresses Guy and adds no address', () => {
    const draft = referralDraftText({
      leadName: 'Ariel Isaac Franco',
      inboundMessage: 'Hi please talk to Guy at our office.',
      ...OPTS,
    });
    assert.equal(draft, ARIEL);
    assert.doesNotMatch(draft, /@/);
    assert.deepEqual(extractReferredContacts('Hi please talk to Guy at our office.', OPTS), []);
  });

  it('an email local part is the first name, and a generic local part is not', () => {
    const fromEmail = referralDraftText({
      leadName: 'Ariel Isaac Franco',
      inboundMessage: 'Looping in guy.smith@orioncityscape.com so he can take this.',
      ...OPTS,
    });
    assert.equal(fromEmail, ARIEL);

    const generic = referralDraftText({
      leadName: 'Ariel Isaac Franco',
      inboundMessage: 'Please talk to our billing contact at info@orioncityscape.com.',
      ...OPTS,
    });
    assert.equal(
      generic,
      'Thank you so much for the contact, Ariel!\n\nHey there, would this be worth meeting about for you?',
    );
    assert.doesNotMatch(generic, /Info/);
    const genericContacts = extractReferredContacts(
      'Please talk to our billing contact at info@orioncityscape.com.',
      OPTS,
    );
    assert.equal(genericContacts[0].email, 'info@orioncityscape.com');
    assert.equal(genericContacts[0].name, '');
  });

  it('a name in the sentence wins over a different email local part', () => {
    const draft = referralDraftText({
      leadName: 'Ariel',
      inboundMessage: 'Please talk to Guy at samuel@orioncityscape.com',
      ...OPTS,
    });
    assert.match(draft, /Hey Guy,/);
    assert.doesNotMatch(draft, /Samuel/);
  });

  it('the template keeps the normal no-sign-off handling and skips the model', async () => {
    assert.equal(stripSignOff(ARIEL), ARIEL);
    const draft = await draftOnly({
      classification: 'INTERESTED',
      inboundMessage: ARIEL_BODY,
      leadName: 'Ariel Isaac Franco',
      bookingLink: 'https://book.example.com/josh',
      includeBookingLink: true,
      clientName: 'Deep Roots',
      voicePrompt: 'Tyler will call from 218-469-3457',
      referredContacts: [{ name: 'Guy', email: 'Guy@orioncityscape.com' }],
    });
    assert.equal(draft, ARIEL);
    assert.equal(fallbackDraftText({
      leadName: 'Ariel Isaac Franco',
      classification: 'INTERESTED',
      inboundMessage: 'Sounds good, send times.',
      clientName: 'Deep Roots',
      voicePrompt: 'Tyler will call from 218-469-3457',
    }).includes('218-469-3457'), true);
  });
});

describe('an existing referral card is updated in place', () => {
  it('a posted card is rewritten and a second card is not posted', () => {
    const posted = arielRow();
    const sibling = arielRow({
      id: 'ariel-dup',
      slack_message_ts: null,
      status: 'suppressed',
      classification: 'NOT_INTERESTED',
      created_at: '2026-10-27T14:58:00Z',
    });
    const actions = planReferralCardActions([sibling, posted]);
    const types = actions.map((a) => `${a.type}:${a.row.id}:${a.reason || ''}`);
    assert.deepEqual(types.sort(), [
      'skip:ariel-dup:card_already_exists',
      'update:ariel-row:',
    ].sort());
  });

  it('no card yet posts exactly one row', () => {
    const first = arielRow({
      id: 'ariel-new',
      slack_message_ts: null,
      status: 'suppressed',
      classification: 'NOT_INTERESTED',
      created_at: '2026-10-27T14:57:10Z',
    });
    const second = arielRow({
      id: 'ariel-later',
      slack_message_ts: null,
      status: 'pending',
      created_at: '2026-10-27T14:58:00Z',
    });
    const actions = planReferralCardActions([second, first]);
    assert.deepEqual(actions.map((a) => `${a.type}:${a.row.id}`), [
      'post:ariel-new',
      'skip:ariel-later',
    ]);
  });

  it('a sent card is left alone', () => {
    const actions = planReferralCardActions([arielRow({ status: 'sent' })]);
    assert.deepEqual(actions.map((a) => a.type), ['skip']);
    assert.equal(actions[0].reason, 'already_actioned');
  });

  it('refresh updates the same Slack ts and never posts or sends', async () => {
    const updates = [];
    const posts = [];
    const saves = [];
    const row = arielRow();
    const result = await refreshReferralDrafts({
      dry: false,
      leadEmail: 'ariel@orioncityscape.com',
      campaignId: '4242292',
      query: async () => ({ rows: [row] }),
      saveDraft: async (saved, draft) => { saves.push({ id: saved.id, draft }); },
      updateCard: async (saved, card) => { updates.push({ ts: saved.slack_message_ts, card }); },
      postCard: async (saved) => { posts.push(saved.id); return { ts: 'new' }; },
    });
    assert.equal(posts.length, 0);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].draft, ARIEL);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].ts, '1761570000.000100');
    assert.equal(updates[0].card.draft, ARIEL);
    assert.equal(updates[0].card.referredContacts[0].email, 'Guy@orioncityscape.com');
    assert.equal(result.updated, 1);
    assert.equal(result.posted, 0);

    const shown = JSON.stringify(buildDraftApprovalCard(cardPayload(row, ARIEL, updates[0].card.referredContacts)));
    assert.match(shown, /Thank you so much for the contact, Ariel/);
    assert.match(shown, /Hey Guy, would this be worth meeting about for you\?/);
    assert.doesNotMatch(shown, /for you guys/);
    assert.match(shown, /approve_reply_cc_referral/);
    assert.match(shown, /Guy@orioncityscape\.com/);
  });

  it('a suppressed email referral the poller would skip still posts once', async () => {
    const posts = [];
    const updates = [];
    let sql = '';
    const row = arielRow({
      slack_message_ts: null,
      status: 'suppressed',
      classification: 'NOT_INTERESTED',
      suppression_reason: 'not_interested',
      created_at: '2024-01-01T00:00:00Z',
    });
    const result = await refreshReferralDrafts({
      dry: false,
      leadEmail: 'ariel@orioncityscape.com',
      campaignId: '4242292',
      query: async (text) => {
        sql = text;
        return { rows: [row] };
      },
      saveDraft: async () => {},
      updateCard: async () => { updates.push('update'); },
      postCard: async (_saved, card) => {
        posts.push(card);
        return { ts: '1761570000.000300' };
      },
    });
    assert.doesNotMatch(sql, /interval '30 days'/);
    assert.equal(updates.length, 0);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].draft, ARIEL);
    assert.equal(posts[0].classification, 'INTERESTED');
    assert.equal(posts[0].referredContacts[0].email, 'Guy@orioncityscape.com');
    assert.equal(result.posted, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.rows[0].action, 'posted');
    const shown = JSON.stringify(buildDraftApprovalCard(posts[0]));
    assert.match(shown, /Hey Guy, would this be worth meeting about for you\?/);
    assert.doesNotMatch(shown, /for you guys/);
    assert.match(shown, /approve_reply_cc_referral/);
    assert.match(shown, /Guy@orioncityscape\.com/);
  });

  it('an unscoped refresh stays inside 30 days', async () => {
    let sql = '';
    await refreshReferralDrafts({
      dry: true,
      query: async (text) => {
        sql = text;
        return { rows: [] };
      },
    });
    assert.match(sql, /interval '30 days'/);
  });

  it('the early already-posted skip recovers a suppressed email referral', () => {
    const sl = fs.readFileSync(path.join(__dirname, '..', 'src/services/smartlead-poller.js'), 'utf8');
    const dedupe = fs.readFileSync(path.join(__dirname, '..', 'src/services/reply-dedupe.js'), 'utf8');
    const earlyStart = sl.indexOf('if (inbound && !staleHistory)');
    const earlyEnd = sl.indexOf('if (staleHistory && client.smartlead_api_key)');
    const early = sl.slice(earlyStart, earlyEnd);
    const postedBlock = early.slice(early.indexOf('if (await alreadyPostedToSlack'));
    assert.match(postedBlock, /return returnPostedOrRecoverReferral\(/);
    assert.doesNotMatch(postedBlock, /return \{ skipped: 'already_posted' \}/);

    const lateStart = sl.indexOf('const smartleadEmailStatsId');
    const lateEnd = sl.indexOf('await cancelForInboundReply');
    const latePosted = sl.slice(lateStart, lateEnd);
    const lateBlock = latePosted.slice(latePosted.indexOf('if (await alreadyPostedToSlack'));
    assert.match(lateBlock, /return returnPostedOrRecoverReferral\(/);

    const helper = sl.slice(
      sl.indexOf('async function returnPostedOrRecoverReferral'),
      sl.indexOf('async function processInboxRow'),
    );
    assert.ok(
      helper.indexOf('recoverSuppressedReferral') < helper.indexOf("skipped: 'already_posted'"),
      'recover the suppressed email referral before counting already_posted',
    );
    assert.doesNotMatch(helper, /claimNewInbound/);
    assert.doesNotMatch(helper, /INSERT INTO pending_replies/);
    assert.doesNotMatch(helper, /lookbackHours|older_than_lookback/);

    const recorded = dedupe.slice(
      dedupe.indexOf('async function inboundAlreadyRecorded'),
      dedupe.indexOf('async function alreadyPostedToSlack'),
    );
    assert.ok(!/status\s*=/.test(recorded) && !/status\s+IN/.test(recorded));
    const unposted = dedupe.slice(
      dedupe.indexOf('async function findUnpostedReply'),
      dedupe.indexOf('function formatCampaignDisplayFromReply'),
    );
    assert.match(unposted, /status IN \('pending', 'alert_only'\)/);
  });

  it('a suppressed row with no Slack ts posts once', async () => {
    const posts = [];
    const row = arielRow({
      slack_message_ts: null,
      status: 'suppressed',
      classification: 'NOT_INTERESTED',
    });
    const result = await refreshReferralDrafts({
      dry: false,
      replyId: row.id,
      query: async () => ({ rows: [row] }),
      saveDraft: async () => {},
      updateCard: async () => { throw new Error('update should not run'); },
      postCard: async (saved, card) => {
        posts.push(card);
        return { ts: '1761570000.000200', skipped: false };
      },
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].draft, ARIEL);
    assert.equal(posts[0].classification, 'INTERESTED');
    assert.equal(result.posted, 1);
    assert.equal(result.updated, 0);
  });

  it('the admin route is a scoped dry-default and does not send', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
    const svc = fs.readFileSync(path.join(__dirname, '..', 'src/services/refresh-referral-draft.js'), 'utf8');
    assert.match(admin, /\/admin\/refresh-referral-draft/);
    assert.match(admin, /leadEmail=ariel@orioncityscape\.com/);
    assert.match(admin, /dry=0/);
    assert.match(admin, /Pass leadEmail or replyId when dry=0/);
    assert.doesNotMatch(svc, /sendReplyToPlatform/);
    assert.doesNotMatch(svc, /sendReply\(/);
    assert.doesNotMatch(admin, /requireAdminApiKey/);
  });
});
