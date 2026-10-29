/**
 * Scott Payea / TechEvo, Oct 26 2026: Smartlead's webhook `text` was a ~250
 * character preview and `html` held the full reply. The card, the stored
 * body, and the drafter must all keep the full message. A preview and the
 * full text are the same reply for dedupe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../src/utils/smartlead-webhook-helpers');
const { extractInboundForwardFields } = require('../src/services/inbound-forward');
const { buildDraftApprovalCard } = require('../src/services/slack');
const {
  summarizeThread,
  threadAndLatestForDraft,
} = require('../src/services/claude-reply-draft');
const { summarizeThread: summarizeThreadForGemini } = require('../src/services/classifier');
const { prepareFollowUpThreadTurns } = require('../src/utils/follow-up-thread-display');
const {
  inboundPrefix,
  normalizeInboundText,
  MIN_CONTAINMENT_LEN,
} = require('../src/services/reply-dedupe');

const SCOTT_FULL = [
  'Josh,',
  '',
  'Thanks for reaching out. I am the founder at TechEvo and we help mid-market operators modernize their field service stack.',
  '',
  'A few things I would want to cover before I put anything on the calendar:',
  '1. Who you have already booked meetings with in home services, and what the show rate looked like.',
  '2. Whether the guarantee is meetings held or meetings booked, and what happens in month two if we are behind.',
  '3. How you handle a technical buyer who wants to see the integration path before a call with me.',
  '',
  'We are not looking for a free pilot. If the fit is real I will loop in our ops lead and we can talk through a ninety-day plan, the handoff, and what you need from us on the first week.',
  '',
  'If that is a fit, I can do a short call next week. I am in Austin and usually free Tuesday or Wednesday afternoon.',
  '',
  'Scott Payea',
  'TechEvo',
].join('\n');

function scottHtml(body) {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<html><body><div>${escaped}</div></body></html>`;
}

function sameReply(x, y) {
  if (inboundPrefix(x) && inboundPrefix(x) === inboundPrefix(y)) return true;
  const a = normalizeInboundText(x);
  const b = normalizeInboundText(y);
  return a.length >= MIN_CONTAINMENT_LEN && b.length >= MIN_CONTAINMENT_LEN
    && (a.startsWith(b) || b.startsWith(a));
}

function sectionText(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === 'section' && b.text && b.text.text)
    .map((b) => b.text.text)
    .join('\n');
}

test('Scott Payea payload: short text preview loses to the full HTML reply', () => {
  assert.ok(SCOTT_FULL.length > 830, `fixture is ${SCOTT_FULL.length} chars`);
  let cutAt = 250;
  while (cutAt < SCOTT_FULL.length && /\s/.test(SCOTT_FULL[cutAt - 1])) cutAt += 1;
  const preview = SCOTT_FULL.slice(0, cutAt);
  assert.ok(preview.length < SCOTT_FULL.length);
  assert.ok(preview.length < 280);
  const parsed = h.parseInboundFromPayload({
    text: preview,
    html: scottHtml(`${SCOTT_FULL}\n\nOn Mon, Oct 26, 2026 at 9:04 AM Josh <josh@salesglider.com> wrote:\nold outbound pitch`),
  }, {});
  const stored = h.cleanInboundReply(parsed);
  assert.ok(stored.includes('Scott Payea'), 'stored text keeps the signature');
  assert.ok(stored.includes('I am in Austin'), 'stored text keeps the end of the reply');
  assert.ok(stored.length > preview.length);
  assert.doesNotMatch(stored, /old outbound pitch/);
  assert.ok(stored.startsWith('Josh,'));
});

test('inbound forward prefers the HTML reply over the text preview', () => {
  const preview = SCOTT_FULL.slice(0, 250);
  const fields = extractInboundForwardFields({
    event_type: 'EMAIL_REPLY',
    email_campaign_id: 1,
    email_lead_id: 2,
    lead_email: 'scott@techevo.com',
    reply_message: { text: preview, html: scottHtml(SCOTT_FULL) },
  });
  assert.ok(fields.inboundMessage.includes('Scott Payea'));
  assert.ok(fields.inboundMessage.length > preview.length);
});

test('message history replaces a preview when it is the longer copy of the same reply', () => {
  const preview = SCOTT_FULL.slice(0, 250);
  const hist = {
    history: [
      {
        type: 'SENT',
        time: '2026-10-25T15:00:00.000Z',
        email_body: 'Earlier outbound about booked meetings.',
      },
      {
        type: 'REPLY',
        time: '2026-10-26T16:12:00.000Z',
        from: 'scott@techevo.com',
        text: preview,
        html: scottHtml(SCOTT_FULL),
      },
    ],
  };
  const fromHist = h.latestInboundFromSmartleadHistory(hist, 'scott@techevo.com');
  assert.ok(fromHist.includes('Scott Payea'));
  const chosen = h.preferFullerInbound(preview, fromHist);
  assert.equal(chosen, fromHist);
  assert.ok(chosen.length > preview.length);

  const different = 'Yes, Tuesday at 2pm works.';
  const older = `${'A previous long reply about a different topic. '.repeat(20)}`;
  assert.equal(h.preferFullerInbound(different, older), different);
});

test('a preview and its full text dedupe as one reply', () => {
  const preview = SCOTT_FULL.slice(0, 250);
  const shortPrefix = SCOTT_FULL.slice(0, 80);
  assert.ok(sameReply(preview, SCOTT_FULL));
  assert.ok(sameReply(SCOTT_FULL, preview));
  assert.equal(inboundPrefix(preview), inboundPrefix(SCOTT_FULL));
  assert.equal(inboundPrefix(`${preview}...`), inboundPrefix(SCOTT_FULL));
  assert.ok(sameReply(shortPrefix, SCOTT_FULL));
  assert.ok(sameReply(SCOTT_FULL, shortPrefix));
  assert.ok(!sameReply(SCOTT_FULL, 'Actually let us do Thursday instead, Scott.'));
});

test('Slack card shows Scott\'s reply and cuts a 6000+ reply at about 600 chars, nothing in a thread', () => {
  const card = buildDraftApprovalCard({
    replyId: 'scott-1',
    leadName: 'Scott Payea',
    leadEmail: 'scott@techevo.com',
    platform: 'smartlead',
    classification: 'QUESTION',
    draft: 'Hey Scott, happy to walk through that.',
    inboundMessage: SCOTT_FULL,
    lastOutboundMessage: 'Worth a quick look at how we book meetings for field-service teams?',
    campaignDisplay: 'TechEvo | Intro',
  });
  const shown = sectionText(card.blocks);
  assert.match(shown, /They replied/);
  assert.ok(shown.includes('Thanks for reaching out'));
  assert.doesNotMatch(shown, /_\(truncated\)_/);
  for (const block of card.blocks) {
    if (block.text && block.text.text) assert.ok(block.text.text.length <= 3000);
  }

  const long = `Opening line about the integration path.\n\n${'We need the full scope of the home-service rollout before we commit to a calendar hold. '.repeat(90)}`;
  assert.ok(long.length > 6000, `long reply is ${long.length} chars`);
  const longCard = buildDraftApprovalCard({
    replyId: 'long-1',
    leadName: 'Scott Payea',
    leadEmail: 'scott@techevo.com',
    platform: 'smartlead',
    classification: 'INTERESTED',
    draft: 'Hey Scott, thanks for laying that out.',
    inboundMessage: long,
    lastOutboundMessage: 'Wanted to send a note.',
    campaignDisplay: 'TechEvo | Intro',
  });
  const longShown = sectionText(longCard.blocks);
  assert.ok(longShown.includes('Opening line about the integration path.'));
  assert.ok(longShown.includes('…'), 'long reply is cut at about 600 chars');
  assert.equal((longCard.overflowBlocks || []).length, 0, 'no part of the reply lives only in a thread');
  assert.ok(longCard.blocks.length <= 50);
  for (const block of longCard.blocks) {
    if (block.text && block.text.text) {
      assert.ok(block.text.text.length <= 3000, `section is ${block.text.text.length} chars`);
    }
  }

  const huge = `${'paragraph of the prospect reply '.repeat(8000)}END-OF-REPLY`;
  const hugeCard = buildDraftApprovalCard({
    replyId: 'huge-1',
    leadName: 'Scott Payea',
    leadEmail: 'scott@techevo.com',
    platform: 'smartlead',
    classification: 'QUESTION',
    inboundMessage: huge,
    lastOutboundMessage: 'Hi Scott',
    campaignDisplay: 'TechEvo | Intro',
  });
  assert.ok(hugeCard.blocks.length <= 50);
  assert.equal((hugeCard.overflowBlocks || []).length, 0);
  const hugeShown = sectionText(hugeCard.blocks);
  assert.ok(hugeShown.includes('paragraph of the prospect reply'));
  assert.ok(hugeShown.length < 1500, 'card shows about 600 chars of the reply');
});

test('ampersand-heavy reply stays under the 3000-char section limit', () => {
  const body = `&`.repeat(4000);
  const card = buildDraftApprovalCard({
    replyId: 'amp-1',
    leadName: 'Scott Payea',
    leadEmail: 'scott@techevo.com',
    platform: 'smartlead',
    classification: 'QUESTION',
    inboundMessage: body,
    lastOutboundMessage: 'Hi',
    campaignDisplay: 'TechEvo',
  });
  const shown = [sectionText(card.blocks), sectionText(card.overflowBlocks)].join('\n');
  assert.equal(shown.split('&amp;').length - 1, 600, 'reply is cut at about 600 chars');
  for (const block of [...card.blocks, ...(card.overflowBlocks || [])]) {
    if (block.text && block.text.text) assert.ok(block.text.text.length <= 3000);
  }
});

test('drafter keeps the full latest reply and drops oldest thread text first', () => {
  const latest = `LATEST-START ${'detail '.repeat(800)} LATEST-END`;
  const oldest = `OLDEST-START ${'old '.repeat(5000)} OLDEST-END`;
  assert.ok(oldest.length > 12000);
  const thread = {
    history: [
      { type: 'SENT', email_body: oldest },
      { type: 'REPLY', email_body: latest },
    ],
  };
  const summary = summarizeThread(thread);
  assert.ok(summary.includes(latest));
  assert.ok(summary.includes('LATEST-START'));
  assert.ok(summary.includes('LATEST-END'));
  assert.ok(!summary.includes('OLDEST-START'));

  const newestAlone = `ONLY-NEW-START ${'n'.repeat(15000)} ONLY-NEW-END`;
  const overCap = summarizeThread({
    messages: [
      { role: 'us', body: oldest },
      { role: 'them', body: newestAlone },
    ],
  });
  assert.ok(overCap.includes('ONLY-NEW-START'));
  assert.ok(overCap.includes('ONLY-NEW-END'));
  assert.ok(overCap.length > 12000);

  const input = threadAndLatestForDraft(thread, latest);
  assert.equal(input.latest, latest.trim());
  assert.ok(input.latest.includes('LATEST-END'));
  assert.equal(input.latest.length, latest.trim().length);

  const geminiThread = `GEMINI-START ${'g'.repeat(5000)} GEMINI-END`;
  const gemini = summarizeThreadForGemini(geminiThread);
  assert.ok(gemini.includes('GEMINI-END'));
  assert.ok(!gemini.includes('GEMINI-START'));
  assert.ok(gemini.length <= 4000);
});

test('older prospect turns are not trimmed to 400 characters', () => {
  const longThem = `Prospect asked for the full plan. ${'scope '.repeat(200)}`;
  assert.ok(longThem.length > 400);
  const turns = prepareFollowUpThreadTurns([
    { role: 'us', body: `Old pitch ${'word '.repeat(200)}`, time: '2026-09-01T12:00:00.000Z' },
    { role: 'them', body: longThem, time: '2026-09-02T12:00:00.000Z' },
    { role: 'us', body: 'A later note from us', time: '2026-09-03T12:00:00.000Z' },
    { role: 'us', body: 'Last send from us', time: '2026-09-04T12:00:00.000Z' },
  ]);
  assert.ok(turns[0].display.length <= 401);
  const theirs = turns.find((t) => t.role === 'them');
  assert.ok(theirs.display.length > 400);
  assert.ok(theirs.display.includes('full plan'));
  assert.doesNotMatch(theirs.display, /…$/);
});

test('On ... wrote: cuts only a line-start header with a date or email', () => {
  const prose = 'We are on track for the rollout. The note I wrote: send the deck next week, still stands.';
  assert.equal(h.stripEmailQuotePrefix(prose), prose);

  const noDate = 'On our side the person who wrote: send it, is out this week. Call me Tuesday.';
  assert.equal(h.stripEmailQuotePrefix(noDate), noDate);

  const quoted = 'Yes please.\nOn Monday Jordan wrote: old';
  assert.equal(h.stripEmailQuotePrefix(quoted), 'Yes please.');

  const gmail = 'Sounds good.\nOn Mon, Oct 26, 2026 at 9:00 AM Josh <josh@x.com> wrote:\n> old pitch';
  assert.equal(h.stripEmailQuotePrefix(gmail), 'Sounds good.');

  const collapsed = 'Sounds good. On Mon, Oct 26, 2026 at 9:00 AM Josh <josh@x.com> wrote: old pitch';
  const cut = h.stripEmailQuotePrefix(collapsed);
  assert.match(cut, /^Sounds good/);
  assert.doesNotMatch(cut, /old pitch/);

  const wednesday = 'I am more interested in staffing help.\n\nOn Wednesday Jordan wrote: old pitch';
  assert.doesNotMatch(h.cleanInboundReply(wednesday), /Jordan wrote/);
});
