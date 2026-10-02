/**
 * Weekly voice learning — pure unit checks. No DB, no network.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit-test';

const {
  stripTrailingSignature,
  cleanOutboundReply,
  smartleadManualPairs,
  heyreachManualPairs,
  sameOutbound,
  excludeSlackSent,
  dropRepeatedOutbounds,
  dedupeKey,
  buildProfilePrompt,
  parseProfileJson,
  selectPairsForProfile,
} = require('../src/services/weekly-voice-learning');
const {
  sanitizeProfile,
  renderLearnedVoiceBlock,
  profileIsEmpty,
  pickPreviousVersion,
} = require('../src/services/voice-profile');

// ── Version history / revert ─────────────────────────────────────────

test('"revert one week back" walks history from the restored week, not the rejected one', () => {
  // History is newest first. v3 (this week) is bad.
  const v1 = { id: 'v1', restored_from: null };
  const v2 = { id: 'v2', restored_from: null };
  const v3 = { id: 'v3', restored_from: null };

  assert.equal(pickPreviousVersion([]), null);
  assert.equal(pickPreviousVersion(null), null);
  assert.equal(pickPreviousVersion([v3, v2, v1]).id, 'v2', 'one back from current = last week');
  assert.equal(pickPreviousVersion([v1]), null, 'nothing earlier than the oldest');

  // Revert copies v2 forward as v4. Reverting "previous" again must not land
  // back on v3 (the one just rejected) — it should continue back to v1.
  const v4 = { id: 'v4', restored_from: 'v2' };
  assert.equal(pickPreviousVersion([v4, v3, v2, v1]).id, 'v1');

  // The following Friday appends v5 (auto-update resumed). "Previous" is now
  // simply v4, the restored version — a normal one-step-back again.
  const v5 = { id: 'v5', restored_from: null };
  assert.equal(pickPreviousVersion([v5, v4, v3, v2, v1]).id, 'v4');
});

// ── Signature / closing stripping ────────────────────────────────────

test('manual SmartLead replies lose mailbox signature and closing, keep the body', () => {
  const raw = [
    'Hey Scott, no catch...trying to provide some value on the front end for you.',
    'Time Monday morning or Tuesday to connect?',
    '',
    'Thanks,',
    'Josh',
    '',
    'Joshua Osborn',
    'SalesGlider | Founder',
    '214-555-1234',
    'https://gosalesglider.com',
  ].join('\n');
  const out = stripTrailingSignature(raw);
  assert.equal(out, 'Hey Scott, no catch...trying to provide some value on the front end for you.\nTime Monday morning or Tuesday to connect?');
});

test('signature stripping never empties a one-line reply', () => {
  assert.equal(stripTrailingSignature('Call me at 214-555-1234 when you get a sec'), 'Call me at 214-555-1234 when you get a sec');
  assert.equal(stripTrailingSignature('Josh'), 'Josh');
});

test('cleanOutboundReply cuts quoted history and HTML', () => {
  const raw = '<div>Sounds good, Tuesday works.<br><br>On Mon, Jan 5, 2026 at 9:00 AM Dean &lt;dean@x.com&gt; wrote:<br>&gt; sure</div>';
  assert.equal(cleanOutboundReply(raw), 'Sounds good, Tuesday works.');
});

// ── SmartLead pairing: structural, not phrase-based ──────────────────

const T = (h) => new Date(Date.UTC(2026, 8, 28, h)).toISOString();

test('a SENT directly after a prospect REPLY is a manual reply; sequence steps are not', () => {
  const history = { history: [
    { type: 'SENT', stats_id: 's1', time: T(1), email_body: 'Cold step 1 about Rangers tickets', email_seq_number: 1 },
    { type: 'SENT', stats_id: 's2', time: T(2), email_body: 'Bumping this up', email_seq_number: 2 },
    { type: 'REPLY', message_id: 'r1', time: T(3), email_body: "What's the catch?" },
    { type: 'SENT', stats_id: 's3', time: T(4), email_body: 'No catch...just trying to provide value up front. Monday or Tuesday?' },
    { type: 'REPLY', message_id: 'r2', time: T(5), email_body: 'Tuesday works' },
  ] };
  const pairs = smartleadManualPairs(history);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].inbound, "What's the catch?");
  assert.match(pairs[0].outbound, /^No catch/);
  assert.equal(pairs[0].sourceId, 'smartlead:s3');
  assert.equal(pairs[0].context.length, 3);
  assert.deepEqual(pairs[0].context.map((c) => c.direction), ['outbound', 'outbound', 'inbound']);
});

test('SmartLead pairs respect the lookback window and skip placeholder inbounds', () => {
  const history = { history: [
    { type: 'REPLY', time: T(1), email_body: 'Interested' },
    { type: 'SENT', stats_id: 'old', time: T(2), email_body: 'Great, how is Thursday?' },
    { type: 'REPLY', time: T(3), email_body: '(no new reply — follow-up re-attempt)' },
    { type: 'SENT', stats_id: 'bump', time: T(4), email_body: 'Still up for those tickets?' },
  ] };
  const since = Date.parse(T(3));
  const pairs = smartleadManualPairs(history, { sinceMs: since });
  assert.equal(pairs.length, 0, 'old pair is outside the window, placeholder pair is skipped');
  assert.equal(smartleadManualPairs(history).length, 1, 'without a window only the real pair remains');
});

// ── HeyReach pairing ─────────────────────────────────────────────────

test('HeyReach pairs our message directly after a prospect message', () => {
  const messages = [
    { sender: 'ME', body: 'Hey Dean, open to a quick chat?', createdAt: T(1), id: 'm1' },
    { sender: 'Dean Smith', body: 'Sure, what is this about?', createdAt: T(2), id: 'm2' },
    { sender: 'ME', body: 'Short version: we fill your calendar. 15 min Tuesday?', createdAt: T(3), id: 'm3' },
    { sender: 'ME', body: 'Bumping this', createdAt: T(4), id: 'm4' },
  ];
  const pairs = heyreachManualPairs(messages, { conversationId: 'c9' });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].inbound, 'Sure, what is this about?');
  assert.equal(pairs[0].sourceId, 'heyreach:c9:m3');
});

// ── Dedupe against Slack sends and templates ─────────────────────────

test('manual candidates that we already sent from Slack are excluded', () => {
  const slackText = 'No catch...just trying to provide value up front. Monday or Tuesday?';
  const pairs = [
    { outbound: `${slackText}\n\nJosh`, threadKey: 'a' },
    { outbound: 'Totally different hand-typed reply', threadKey: 'b' },
    { outbound: 'No catch...just trying', threadKey: 'c' },
  ];
  const kept = excludeSlackSent(pairs, new Set([slackText.toLowerCase()]));
  assert.deepEqual(kept.map((p) => p.threadKey), ['b', 'c'], 'tail differences match; short texts need equality');
  assert.ok(sameOutbound('Tuesday works', 'Tuesday works'));
  assert.ok(!sameOutbound('Tuesday works', 'Wednesday works'));
  assert.equal(dedupeKey('  A   b  ').length, 3);
});

test('the same outbound text across different threads is a template, not a voice example', () => {
  const pairs = [
    { outbound: 'Hey, still interested in the Rangers tickets?', threadKey: 't1' },
    { outbound: 'Hey, still interested in the Rangers tickets?', threadKey: 't2' },
    { outbound: 'Ha, fair enough. What would make this worth 15 minutes?', threadKey: 't3' },
    { outbound: 'Ha, fair enough. What would make this worth 15 minutes?', threadKey: 't3' },
  ];
  const kept = dropRepeatedOutbounds(pairs);
  assert.equal(kept.length, 2, 'repeat inside one thread is fine; repeat across threads is dropped');
  assert.ok(kept.every((p) => p.threadKey === 't3'));
});

// ── Profile synthesis prompt + parsing ───────────────────────────────

test('profile prompt weights edited replies and forbids URLs / contradictions', () => {
  const pairs = [
    { source: 'slack_edited', platform: 'smartlead', classification: 'QUESTION', inbound: 'Cost?', originalDraft: 'Happy to jump on a quick call…', outbound: 'Ok great! Most clients prefer monthly…', sentAt: T(2) },
    { source: 'manual_smartlead', platform: 'smartlead', inbound: 'Sure', outbound: 'Sounds good, Thursday?', sentAt: T(3) },
    { source: 'slack_approved', platform: 'heyreach', inbound: 'Tell me more', outbound: 'Short version…', sentAt: T(4) },
  ];
  const selected = selectPairsForProfile(pairs, 10);
  assert.deepEqual(selected.map((p) => p.source), ['slack_edited', 'manual_smartlead', 'slack_approved']);

  const prompt = buildProfilePrompt({
    scope: 'client',
    client: { name: 'SalesGlider', voice_prompt: 'You are Joshua Osborn, CEO.' },
    pairs: selected,
    previousProfile: { voice_rules: ['Short'] },
  });
  assert.match(prompt, /AI draft before Josh edited it: Happy to jump/);
  assert.match(prompt, /Never include URLs/);
  assert.match(prompt, /no sign-off or signature/);
  assert.match(prompt, /booking link only when the prospect asks/);
  assert.match(prompt, /PREVIOUS PROFILE/);

  const globalPrompt = buildProfilePrompt({ scope: 'global', pairs: selected, previousProfile: null });
  assert.match(globalPrompt, /GLOBAL/);
  assert.match(globalPrompt, /\(none yet\)/);
});

test('profile JSON parsing tolerates fences and sanitizer enforces caps and strips URLs', () => {
  const parsed = parseProfileJson('```json\n{"voice_rules":["Opens with Hey {first name}","Uses ... not dashes"],"client_notes":["Carlos stops by in person","Book at https://calendly.com/x"],"signature_phrases":["no catch"],"avoid":["Best regards sign-offs"]}\n```');
  assert.ok(parsed);
  const clean = sanitizeProfile(parsed, { scope: 'client' });
  assert.deepEqual(clean.client_notes, ['Carlos stops by in person'], 'URL-bearing note dropped');
  assert.equal(clean.voice_rules.length, 2);
  assert.equal(parseProfileJson('not json'), null);

  const global = sanitizeProfile(parsed, { scope: 'global' });
  assert.deepEqual(global.client_notes, [], 'global scope never carries client notes');

  const many = sanitizeProfile({ voice_rules: Array.from({ length: 30 }, (_, i) => `rule ${i}`) });
  assert.equal(many.voice_rules.length, 10);
  assert.ok(profileIsEmpty(sanitizeProfile({})));
});

test('rendered block puts client lines first and tells the model operational rules still win', () => {
  const block = renderLearnedVoiceBlock({
    global: { voice_rules: ['Short and warm'], signature_phrases: ['no catch'], avoid: ['corporate filler'] },
    client: { voice_rules: ['Lead with the tickets'], client_notes: ['Carlos meets in person at the dealership'] },
    clientName: 'Vasco Warranty',
  });
  assert.match(block, /^LEARNED VOICE/);
  assert.match(block, /operational rules in this prompt still win/);
  assert.ok(block.indexOf('Lead with the tickets') < block.indexOf('Short and warm'));
  assert.match(block, /CLIENT NOTES — Vasco Warranty/);
  assert.match(block, /Carlos meets in person/);
  assert.match(block, /PHRASES JOSH ACTUALLY USES: "no catch"/);
  assert.equal(renderLearnedVoiceBlock({}), '', 'nothing learned → nothing injected');
});
