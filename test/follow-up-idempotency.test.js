/**
 * One card and one send per follow-up step.
 *
 * Jeff Miller, 2026-10-20: two approval cards for the same follow-up, both
 * approved, two deliveries. The drafts diverged in the first sentence, so
 * the sent-text check missed the second one.
 *
 * Travis Shindelbower, 2026-10-21: one Smartlead send rendered three times
 * on the follow-up card, and Reject posted "Rejected — not interested" and
 * cancelled the rest of the cadence.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { extractThreadMessages } = require('../src/utils/thread-transcript');
const { dedupeThreadTurns } = require('../src/utils/follow-up-thread-display');
const {
  outboundSendBlockedReason,
  sameOutboundText,
  LEGACY_FOLLOW_UP_WINDOW_MS,
} = require('../src/services/reply-dedupe');
const { buildSentConfirmationBlocks } = require('../src/services/slack');

const TRAVIS = 'Hey Travis, circling back on the conversation. Still worth a quick call this week if you have 15 minutes.';
const TRAVIS_SIG = `${TRAVIS}\n\nMiyu Suzuki\nEmcor Mesa Energy Systems`;
const TRAVIS_LINK = `${TRAVIS}\n[https://book.gosalesglider.com/josh]`;

const JEFF_A = 'Hey Jeff, totally fair. Still worth a chat about the seats and how we usually run this.';
const JEFF_B = 'Hey Jeff, totally fair on the seats. Still worth a chat about how we usually run this.';

function blockText(blocks) {
  return JSON.stringify(blocks);
}

test('the same Smartlead email is not repeated on the follow-up card', () => {
  const out = extractThreadMessages('smartlead', {
    history: [
      {
        type: 'SENT',
        time: '2026-10-21T12:37:21.000Z',
        email_body: TRAVIS_SIG,
        message_id: '<travis-follow-up@smartlead>',
        stats_id: 'shared-thread-stats',
      },
      {
        type: 'SENT',
        time: '2026-10-21T12:37:21.000Z',
        email_body: TRAVIS_LINK,
        message_id: '<travis-follow-up@smartlead>',
        stats_id: 'shared-thread-stats',
      },
      {
        type: 'SENT',
        time: '2026-10-21T12:37:22.000Z',
        email_body: TRAVIS_SIG,
        message_id: '<travis-follow-up-render@smartlead>',
        stats_id: 'shared-thread-stats',
      },
    ],
  }, {
    extraMessages: [{ role: 'us', body: TRAVIS, time: '2026-10-21T12:37:21.000Z' }],
  });

  const ours = out.filter((m) => m.role === 'us');
  assert.equal(ours.length, 1, 'signature, link-bracket, and stored send are one turn');
  assert.match(ours[0].body, /circling back on the conversation/);
});

test('two real follow-up sends stay as two turns', () => {
  const out = dedupeThreadTurns([
    { role: 'us', body: JEFF_A, messageId: '<jeff-2237@smartlead>', time: '2026-10-20T22:37:13.000Z' },
    { role: 'us', body: JEFF_B, messageId: '<jeff-2249@smartlead>', time: '2026-10-20T22:49:24.000Z' },
  ]);
  assert.equal(out.length, 2, 'a reworded second send is not the same email');
});

test('a shared Smartlead stats_id does not collapse different emails', () => {
  const out = extractThreadMessages('smartlead', {
    history: [
      {
        type: 'REPLY',
        time: '2026-10-20T18:00:00.000Z',
        email_body: 'The seats on the 12th do not work for us.',
        message_id: '<jeff-reply@parlay>',
        stats_id: '90121c16-89ae-465f-ac92-d5683f825ea2',
      },
      {
        type: 'SENT',
        time: '2026-10-20T22:37:13.000Z',
        email_body: JEFF_A,
        message_id: '<jeff-2237@smartlead>',
        stats_id: '90121c16-89ae-465f-ac92-d5683f825ea2',
      },
    ],
  });
  assert.equal(out.length, 2);
});

test('same follow-up step blocks a reworded second approve', () => {
  assert.equal(sameOutboundText(JEFF_A, JEFF_B), false,
    'Jeff\'s two openings diverge inside the prefix, which is why the old text check missed them');

  const reason = outboundSendBlockedReason({
    candidate: {
      classification: 'FOLLOW_UP',
      followUpStep: 2,
      sourcePendingReplyId: 'src-1',
      replyText: JEFF_B,
    },
    existing: {
      status: 'sent',
      classification: 'FOLLOW_UP',
      followUpStep: 2,
      sourcePendingReplyId: 'src-1',
      sentReply: JEFF_A,
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(reason, 'same_step');
});

test('a different cadence step is not blocked by the previous send', () => {
  const reason = outboundSendBlockedReason({
    candidate: {
      classification: 'FOLLOW_UP',
      followUpStep: 3,
      sourcePendingReplyId: 'src-1',
      replyText: 'Hey Jeff, those times got grabbed. Thursday at 10 or Friday at 2?',
    },
    existing: {
      status: 'sending',
      classification: 'FOLLOW_UP',
      followUpStep: 2,
      sourcePendingReplyId: 'src-1',
      draftReply: JEFF_A,
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(reason, null);
});

test('identical text always blocks, including across steps', () => {
  const reason = outboundSendBlockedReason({
    candidate: {
      classification: 'FOLLOW_UP',
      followUpStep: 3,
      sourcePendingReplyId: 'src-1',
      replyText: JEFF_A,
    },
    existing: {
      status: 'sent',
      classification: 'FOLLOW_UP',
      followUpStep: 2,
      sourcePendingReplyId: 'src-1',
      sentReply: JEFF_A,
    },
  });
  assert.equal(reason, 'same_text');
});

test('legacy cards with no step id still block an in-flight or recent send', () => {
  const now = Date.now();
  assert.equal(outboundSendBlockedReason({
    now,
    candidate: { classification: 'FOLLOW_UP', replyText: JEFF_B },
    existing: {
      status: 'sending',
      classification: 'FOLLOW_UP',
      draftReply: JEFF_A,
      updatedAt: new Date(now - 60 * 1000).toISOString(),
    },
  }), 'in_flight');

  assert.equal(outboundSendBlockedReason({
    now,
    candidate: { classification: 'FOLLOW_UP', replyText: JEFF_B },
    existing: {
      status: 'sent',
      classification: 'FOLLOW_UP',
      sentReply: JEFF_A,
      updatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    },
  }), 'recent_follow_up');

  assert.equal(outboundSendBlockedReason({
    now,
    candidate: { classification: 'FOLLOW_UP', replyText: JEFF_B },
    existing: {
      status: 'sent',
      classification: 'FOLLOW_UP',
      sentReply: JEFF_A,
      updatedAt: new Date(now - LEGACY_FOLLOW_UP_WINDOW_MS - 60 * 1000).toISOString(),
    },
  }), null);
});

test('the same follow-up id blocks even when the step columns are empty', () => {
  assert.equal(outboundSendBlockedReason({
    candidate: {
      classification: 'FOLLOW_UP',
      followUpId: 'fu-1',
      replyText: JEFF_B,
    },
    existing: {
      status: 'approved',
      classification: 'FOLLOW_UP',
      followUpId: 'fu-1',
      draftReply: JEFF_A,
    },
  }), 'same_follow_up');
});

test('approve claims the person before the Smartlead send', () => {
  const send = read('src/services/reply-send.js');
  const fn = send.slice(
    send.indexOf('async function sendReplyToPlatform'),
    send.indexOf('async function maybeBookMeetingAfterSend')
  );
  const claimAt = fn.indexOf('claimOutboundSend');
  const textAt = fn.indexOf('alreadySentSameOutbound');
  const apiAt = fn.indexOf('smartlead.sendReply');
  const fixtureAt = fn.indexOf('isSlackTestFixtureReply');
  const portalAt = fn.indexOf('assertNotClaimedOrThrow');
  assert.ok(fixtureAt >= 0 && fixtureAt < portalAt && portalAt < claimAt,
    'fixture and portal checks stay ahead of the send claim');
  assert.ok(claimAt >= 0 && claimAt < textAt && textAt < apiAt,
    'claim, then the sent-text check, then the provider call');

  const dedupe = read('src/services/reply-dedupe.js');
  const claimFn = dedupe.slice(
    dedupe.indexOf('async function claimOutboundSend'),
    dedupe.indexOf('const SLACK_CLAIM_PREFIX')
  );
  assert.match(claimFn, /pg_advisory_xact_lock/);
  assert.match(claimFn, /status = 'sending'/);
  assert.match(claimFn, /status = 'skipped'/);
  const lockAt = claimFn.indexOf('pg_advisory_xact_lock');
  const forUpdateAt = claimFn.indexOf('FOR UPDATE');
  assert.ok(lockAt >= 0 && lockAt < forUpdateAt, 'lock the person before FOR UPDATE');
});

test('a follow-up card is claimed before it is inserted', () => {
  const runner = read('src/services/follow-up-runner.js');
  const fn = runner.slice(
    runner.indexOf('async function postFollowUpCard'),
    runner.indexOf('async function resolve')
  );
  const claimAt = fn.indexOf("status = 'posting'");
  const insertAt = fn.indexOf('INSERT INTO pending_replies');
  assert.ok(claimAt >= 0 && insertAt > claimAt, 'claim posting before inserting the card');
  assert.match(fn, /follow_up_id/);
  assert.match(fn, /duplicate_step/);

  const cron = read('src/cron.js');
  const digest = cron.slice(cron.indexOf('const card = await postFollowUpCard'));
  const postedAt = digest.indexOf('posted++');
  const claimBlock = digest.slice(0, postedAt);
  assert.match(claimBlock, /if \(!card\)/);
  assert.doesNotMatch(claimBlock, /notified/,
    'a null card must not be marked notified — that clobbers the worker still posting');

  const migration = read('migrations/037_follow_up_idempotency.sql');
  assert.match(migration, /idx_pending_replies_one_follow_up_card/);
  assert.match(migration, /idx_outbound_follow_ups_step_by_email/);
  assert.match(migration, /idx_outbound_follow_ups_step_by_lead/);
  assert.match(migration, /00000000-0000-0000-0000-000000000000/);
  const schema = read('schema.sql');
  assert.match(schema, /idx_pending_replies_one_follow_up_card/);
  assert.match(schema, /'sending'/);
  assert.match(schema, /'skipped'/);
  assert.match(schema, /'posting'/);
});

test('Reject on a follow-up card says the next follow-up is still scheduled', () => {
  for (const actionKind of ['skipped', 'rejected']) {
    const blocks = buildSentConfirmationBlocks({
      leadName: 'Travis Shindelbower',
      leadEmail: 'tshindelbower@cityofslt.gov',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      inboundMessage: 'Happy to find a time.',
      lastOutboundMessage: TRAVIS,
      actionKind,
      extraFooter: 'Skipped — next follow-up still scheduled',
    });
    const text = blockText(blocks);
    assert.match(text, /Skipped — next follow-up still scheduled/);
    assert.doesNotMatch(text, /not interested/i);
    assert.doesNotMatch(text, /Rejected — not interested/);
  }

  const inbox = buildSentConfirmationBlocks({
    leadName: 'Travis Shindelbower',
    leadEmail: 'tshindelbower@cityofslt.gov',
    platform: 'smartlead',
    classification: 'INTERESTED',
    inboundMessage: 'Not a fit.',
    actionKind: 'rejected',
  });
  const inboxText = blockText(inbox);
  assert.match(inboxText, /Rejected — not interested/);
  assert.doesNotMatch(inboxText, /Skipped — next follow-up still scheduled/);
});

test('one card and one send per follow-up step', () => {
  const runner = read('src/services/follow-up-runner.js');
  const send = read('src/services/reply-send.js');
  const route = read('src/routes/slack.js');
  assert.match(runner, /status = 'posting'/);
  assert.match(send, /claimOutboundSend/);
  const reject = route.slice(
    route.indexOf('async function handleReject'),
    route.indexOf("classification = 'NOT_INTERESTED'")
  );
  assert.match(reject, /FOLLOW_UP/);
  assert.match(reject, /Skipped — next follow-up still scheduled/);
  assert.doesNotMatch(reject, /cancelPendingForThread/);
  assert.doesNotMatch(reject, /markLeadNotInterested/);
});
