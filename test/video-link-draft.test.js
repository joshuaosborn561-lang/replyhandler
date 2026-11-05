/**
 * SalesGlider offers a video. The link comes from the client row
 * (or SALESGLIDER_VIDEO_LINK when that row is empty). It is not
 * hardcoded in the classifier.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveClientVideoLink,
  videoOfferDraftForReply,
} = require('../src/utils/video-link');

const LINK = 'https://www.gosalesglider.com/watch/v1';
const SG = { name: 'SalesGlider', video_link: LINK };
const OTHER = { name: 'Vector', video_link: null };
const THREAD = {
  history: [{ type: 'SENT', email_body: 'Want me to send a short video on what we do?' }],
};

test('an SG video request includes the client video link', () => {
  const draft = videoOfferDraftForReply({
    client: SG,
    classification: 'INTERESTED',
    inboundMessage: 'send the video',
  });
  assert.match(draft, new RegExp(LINK.replace(/[.]/g, '\\.')));
  assert.match(draft, /^Here you go: /);
  assert.match(draft, /quick call after if it's useful/);

  const accepted = videoOfferDraftForReply({
    client: SG,
    classification: 'QUESTION',
    inboundMessage: 'sure, send it',
    threadContext: THREAD,
  });
  assert.match(accepted, new RegExp(LINK.replace(/[.]/g, '\\.')));
});

test('an SG reply that is not about the video has no link', () => {
  const draft = videoOfferDraftForReply({
    client: SG,
    classification: 'MEETING_PROPOSED',
    inboundMessage: 'Tuesday at 2pm works for a call',
    threadContext: THREAD,
  });
  assert.equal(draft, '');
  const bareYes = videoOfferDraftForReply({
    client: SG,
    classification: 'INTERESTED',
    inboundMessage: 'yes please',
    threadContext: { history: [{ type: 'SENT', email_body: 'Does Thursday work?' }] },
  });
  assert.equal(bareYes, '');
});

test('a non-SG video-ish reply does not get the SalesGlider link', () => {
  const draft = videoOfferDraftForReply({
    client: OTHER,
    classification: 'INTERESTED',
    inboundMessage: 'sure, send the video',
    threadContext: THREAD,
    env: { SALESGLIDER_VIDEO_LINK: LINK },
  });
  assert.equal(draft, '');
  assert.equal(resolveClientVideoLink(OTHER, { SALESGLIDER_VIDEO_LINK: LINK }), '');
});

test('DQ, unsubscribe, and departure never get the video link', () => {
  for (const inboundMessage of [
    'please unsubscribe me and do not send the video',
    'I left the company. Please send the video to my replacement.',
    'not interested in the video',
  ]) {
    assert.equal(videoOfferDraftForReply({
      client: SG,
      classification: 'INTERESTED',
      inboundMessage,
      threadContext: THREAD,
    }), '');
  }
  assert.equal(videoOfferDraftForReply({
    client: SG,
    classification: 'NOT_INTERESTED',
    inboundMessage: 'send the video',
  }), '');
  assert.equal(videoOfferDraftForReply({
    client: SG,
    classification: 'REMOVE_ME',
    inboundMessage: 'send the video',
  }), '');
  assert.equal(videoOfferDraftForReply({
    client: SG,
    classification: 'AUTOMATED_NOTICE',
    inboundMessage: 'send the video',
  }), '');
});

test('SalesGlider falls back to SALESGLIDER_VIDEO_LINK when the column is empty', () => {
  const client = { name: 'SalesGlider', video_link: '' };
  assert.equal(resolveClientVideoLink(client, {}), '');
  assert.equal(resolveClientVideoLink(client, { SALESGLIDER_VIDEO_LINK: LINK }), LINK);
  const draft = videoOfferDraftForReply({
    client,
    classification: 'INTERESTED',
    inboundMessage: 'send the video',
    env: { SALESGLIDER_VIDEO_LINK: LINK },
  });
  assert.match(draft, /watch\/v1/);
});

test('the classifier does not hardcode the watch URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/classifier.js'), 'utf8');
  assert.doesNotMatch(src, /gosalesglider\.com\/watch/);
  assert.match(src, /videoOfferDraftForReply/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'migrations/059_client_video_link.sql'), 'utf8'), /video_link/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8'), /video_link/);
});
