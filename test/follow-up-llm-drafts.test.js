const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtures } = require('./fixtures/follow-up-threads');
const {
  buildFollowUpPrompt,
  parseFollowUpModelJson,
  FOLLOW_UP_RULES,
  generateFollowUpClaudeDraft,
} = require('../src/services/claude-reply-draft');
const {
  draftReattemptToBook,
  resetFollowUpClaudeBudget,
  followUpClaudeCap,
} = require('../src/services/follow-up-drafts');
const {
  clientLoopContact,
  clientLoopContactPhrase,
  rewriteLoopInCopy,
} = require('../src/utils/client-loop-contact');
const { alwaysForwardEmailsForProspectCc } = require('../src/services/client-cc');
const {
  formatThreadForPrompt,
  cleanThreadBody,
  prepareFollowUpThreadTurns,
} = require('../src/utils/follow-up-thread-display');
const { attachFollowUpMeta, readFollowUpMeta } = require('../src/utils/follow-up-meta');
const smartlead = require('../src/services/smartlead');

describe('FOLLOW_UP LLM continuation drafts', () => {
  it('prompt includes the full thread and the prospect ask for every fixture', () => {
    for (const fx of fixtures) {
      const { user, threadBlock, system } = buildFollowUpPrompt({
        leadName: fx.leadName,
        threadMessages: fx.threadMessages,
        lastInboundMessage: fx.lastInboundMessage,
        lastOutboundMessage: fx.lastOutboundMessage,
        step: fx.step,
        daysSinceLastMessage: fx.daysSinceLastMessage,
        bookingLink: 'https://book.example.test/intro',
        slots: [
          { label: 'Tue, Oct 7, 10:00 AM CDT' },
          { label: 'Wed, Oct 8, 2:00 PM CDT' },
        ],
        platform: 'smartlead',
        voicePrompt: 'Write as our SDR. Loop in Miles from our side for decks.',
      });
      assert.match(threadBlock, new RegExp(fx.prospectAsk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(user, /<current_thread>/);
      assert.match(user, new RegExp(fx.prospectAsk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      for (const turn of fx.threadMessages) {
        const snippet = turn.body.slice(0, 24);
        assert.ok(threadBlock.includes(snippet), `${fx.id} dropped thread turn: ${snippet}`);
      }
      assert.match(system, /needs_client/);
      assert.match(system, /never stall for Josh/i);
      assert.doesNotMatch(system, /NEEDS JOSH/);
      assert.doesNotMatch(system, /CLIENT FOUNDER/);
      assert.match(system, /Miles from our side/);
      assert.match(system, /Never say founder/);
      assert.doesNotMatch(system, /our \[title\]/);
    }
  });

  it('FOLLOW_UP_RULES forbids templates, Josh-wait, and invented facts', () => {
    assert.match(FOLLOW_UP_RULES, /natural next message/i);
    assert.match(FOLLOW_UP_RULES, /needs_client/);
    assert.match(FOLLOW_UP_RULES, /never stall for Josh/);
    assert.match(FOLLOW_UP_RULES, /PRICING/);
    assert.match(FOLLOW_UP_RULES, /ONE-PAGER \/ DECK/);
    assert.match(FOLLOW_UP_RULES, /Never say founder/);
    assert.match(FOLLOW_UP_RULES, /from our side/);
    assert.doesNotMatch(FOLLOW_UP_RULES, /\[title\]/);
  });

  it('parseFollowUpModelJson reads needs_client and falls back to plain text', () => {
    const parsed = parseFollowUpModelJson(JSON.stringify({
      draft: 'Hey Alex, looping in Miles from our side to send the one-pager.',
      needs_client: true,
      what_to_send: 'one-pager',
    }));
    assert.equal(parsed.needsClient, true);
    assert.equal(parsed.whatToSend, 'one-pager');
    const plain = parseFollowUpModelJson('Hey Riley, happy to walk through that on a quick call.');
    assert.equal(plain.needsClient, false);
    assert.match(plain.draft, /quick call/);
  });

  it('mocked Claude path gets the full thread and returns loop-in-client', async () => {
    resetFollowUpClaudeBudget();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const fx = fixtures.find((f) => f.id === 'send-it-over');
    let seen = null;
    try {
      const result = await draftReattemptToBook({
        leadName: fx.leadName,
        lastInboundMessage: fx.lastInboundMessage,
        lastOutboundMessage: fx.lastOutboundMessage,
        threadMessages: fx.threadMessages,
        step: fx.step,
        daysSinceLastMessage: fx.daysSinceLastMessage,
        loopContact: { firstName: 'Miles' },
        voicePrompt: 'Write as our SDR. Loop in Miles from our side for decks.',
        claudeGenerate: async (args) => {
          seen = args;
          return {
            text: 'Hey Jordan, looping in Miles from our side to send that one-pager over.',
            needsClient: true,
            whatToSend: 'one-pager',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 800, output_tokens: 60 },
          };
        },
        geminiGenerate: async () => { throw new Error('gemini should not run'); },
      });
      assert.equal(result.source, 'claude');
      assert.equal(result.needsClient, true);
      assert.equal(result.whatToSend, 'one-pager');
      assert.match(result.text, /one-pager/);
      assert.match(result.text, /Miles from our side/);
      assert.doesNotMatch(result.text, /\bfounder\b/i);
      assert.doesNotMatch(result.text, /director of sales/i);
      assert.equal(seen.threadMessages.length, fx.threadMessages.length);
      assert.equal(seen.lastInboundMessage, fx.prospectAsk);
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('rewrites a founder loop-in line to the configured contact', async () => {
    resetFollowUpClaudeBudget();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const result = await draftReattemptToBook({
        leadName: 'Jordan Lee',
        lastInboundMessage: 'Yes send it over',
        voicePrompt: 'Loop in Miles from our side for decks.',
        claudeGenerate: async () => ({
          text: 'Hey Jordan, looping in our founder to send that one-pager.',
          needsClient: true,
          whatToSend: 'one-pager',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        geminiGenerate: async () => { throw new Error('gemini should not run'); },
      });
      assert.match(result.text, /Miles from our side/);
      assert.doesNotMatch(result.text, /\bfounder\b/i);
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('pricing-style mock never sets needs_client', async () => {
    resetFollowUpClaudeBudget();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const result = await draftReattemptToBook({
        leadName: 'Riley Chen',
        lastInboundMessage: 'What do you charge?',
        lastOutboundMessage: 'Worth a short call this week?',
        threadMessages: [
          { role: 'us', body: 'Worth a short call this week?', time: '2026-09-13T14:00:00.000Z' },
          { role: 'them', body: 'What do you charge?', time: '2026-09-14T14:00:00.000Z' },
        ],
        step: 1,
        claudeGenerate: async () => ({
          text: 'Hey Riley, happy to walk through pricing on a quick call.',
          needsClient: false,
          whatToSend: null,
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 40 },
        }),
        geminiGenerate: async () => { throw new Error('gemini should not run'); },
      });
      assert.equal(result.needsClient, false);
      assert.match(result.text, /pricing on a quick call/i);
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('principal-voice drafts never set needs_client', async () => {
    resetFollowUpClaudeBudget();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const result = await draftReattemptToBook({
        leadName: 'Jordan Lee',
        lastInboundMessage: 'Yes send it over',
        voicePrompt: 'You are Joshua. I am the CEO. Never say our CEO.',
        claudeGenerate: async () => ({
          text: 'Hey Jordan, I will send that over.',
          needsClient: true,
          whatToSend: 'deck',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        geminiGenerate: async () => { throw new Error('gemini should not run'); },
      });
      assert.equal(result.needsClient, false);
    } finally {
      if (prev == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('falls back to the template only after both LLMs fail, and logs loudly', async () => {
    resetFollowUpClaudeBudget();
    const prevA = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const errors = [];
    const orig = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      const result = await draftReattemptToBook({
        leadName: 'Alex Rivera',
        lastOutboundMessage: 'Happy to jump on a quick call and walk through getting you more business clients.',
        step: 1,
        claudeGenerate: async () => { throw new Error('claude down'); },
        geminiGenerate: async () => { throw new Error('gemini down'); },
      });
      assert.equal(result.source, 'template');
      assert.match(result.text, /still interested/i);
      assert.ok(errors.some((e) => /BOTH LLMs failed/i.test(e)));
    } finally {
      console.error = orig;
      if (prevA == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevA;
    }
  });

  it('follow-up Claude path is not bulk-disabled', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/claude-reply-draft.js'),
      'utf8'
    );
    const fn = src.slice(src.indexOf('async function generateFollowUpClaudeDraft'));
    assert.doesNotMatch(fn, /hard-disabled for bulk/);
    assert.match(src, /Allowed in bulk\/poller\/cron/);
    assert.equal(typeof generateFollowUpClaudeDraft, 'function');
    assert.ok(followUpClaudeCap() >= 0);
  });

  it('loop-in contact is first name from our side, never founder, title, or Josh', () => {
    assert.equal(clientLoopContactPhrase({
      voicePrompt: 'You are Joshua Osborn, founder/CEO. I am the CEO.',
    }), null);
    assert.equal(clientLoopContactPhrase({
      voicePrompt: 'Loop in Miles from our side for decks.',
    }), 'Miles from our side');
    assert.equal(clientLoopContactPhrase({
      voicePrompt: 'Loop in Roger from our side.',
    }), 'Roger from our side');
    const named = clientLoopContact({
      voicePrompt: 'Loop Taylor in for decks.',
    });
    assert.equal(named.firstName, 'Taylor');
    assert.equal(named.title, undefined);
    assert.equal(clientLoopContactPhrase({
      voicePrompt: 'Taylor is the founder. Loop Taylor in for decks.',
    }), 'Taylor from our side');
    assert.equal(
      rewriteLoopInCopy('Hey Alex, looping in our founder to send that.', 'Miles'),
      'Hey Alex, looping in Miles from our side to send that.'
    );
    assert.equal(
      rewriteLoopInCopy('Hey Alex, looping in Miles, our director of sales, to send that.', 'Miles'),
      'Hey Alex, looping in Miles from our side to send that.'
    );
  });

  it('Send + CC uses Always-forward example.com addresses only', () => {
    const cc = alwaysForwardEmailsForProspectCc({
      cc_emails: 'contact@example.com, ae@example.com',
      cc_email: 'legacy@example.com',
      cc_round_robin_emails: 'rep@example.com',
    });
    assert.equal(cc, 'contact@example.com, ae@example.com');
    assert.doesNotMatch(cc, /rep@example.com/);
    assert.equal(alwaysForwardEmailsForProspectCc({
      cc_email: 'legacy@example.com',
    }), 'legacy@example.com');
    assert.equal(alwaysForwardEmailsForProspectCc({}), '');
  });

  it('formatThreadForPrompt keeps every turn', () => {
    const fx = fixtures[0];
    const text = formatThreadForPrompt(fx.threadMessages);
    assert.match(text, /Prospect /);
    assert.match(text, /Josh /);
    assert.match(text, /send the details first/);
  });

  it('strips signatures and disclaimers and trims older turns', () => {
    const cleaned = cleanThreadBody(
      'Can you send the details first?\n\nAlex Rivera\nCEO, Example Co\n555-010-1234\nhttps://example.com\n\nThis email is confidential and intended solely for the addressee.'
    );
    assert.match(cleaned, /send the details first/);
    assert.doesNotMatch(cleaned, /confidential/);
    assert.doesNotMatch(cleaned, /555-010-1234/);

    const turns = prepareFollowUpThreadTurns([
      { role: 'us', body: `Old pitch ${'word '.repeat(200)}`, time: '2026-09-01T12:00:00Z' },
      { role: 'them', body: 'Short ask', time: '2026-09-02T12:00:00Z' },
      { role: 'us', body: 'Last send from us', time: '2026-09-03T12:00:00Z' },
    ]);
    assert.ok(turns[0].display.length <= 401);
    assert.equal(turns[1].display, 'Short ask');
    assert.equal(turns[2].display, 'Last send from us');
    assert.match(turns[0].label, /^us/);
    assert.match(turns[1].label, /^them/);
  });

  it('persists needs_client on thread_context.follow_up_meta', () => {
    const stored = attachFollowUpMeta({ history: [] }, { needsClient: true, whatToSend: 'deck' });
    assert.equal(stored.follow_up_meta.needs_client, true);
    assert.equal(stored.follow_up_meta.what_to_send, 'deck');
    const read = readFollowUpMeta(JSON.stringify(stored));
    assert.equal(read.needsClient, true);
    assert.equal(read.whatToSend, 'deck');
    const off = readFollowUpMeta(attachFollowUpMeta({ history: [] }, { needsClient: false }));
    assert.equal(off.needsClient, false);
    assert.equal(off.whatToSend, null);
  });

  it('SmartLead reply-email-thread payload includes optional cc and bcc', async () => {
    const calls = [];
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, text: async () => JSON.stringify({ success: true }) };
    };
    try {
      await smartlead.sendReply('test-key', 11, 22, {
        replyText: 'Hey there',
        emailStatsId: 'stats-1',
        ccEmails: 'contact@example.com',
        bccEmails: 'ops@example.com',
      });
      assert.match(calls[0].url, /\/campaigns\/11\/reply-email-thread/);
      assert.doesNotMatch(calls[0].url, /\/leads\/reply-email-thread/);
      assert.equal(calls[0].body.cc, 'contact@example.com');
      assert.equal(calls[0].body.bcc, 'ops@example.com');
      assert.equal(calls[0].body.email_stats_id, 'stats-1');

      calls.length = 0;
      await smartlead.sendReply('test-key', 11, 22, {
        replyText: 'Hey there',
        emailStatsId: 'stats-1',
      });
      assert.equal(calls[0].body.cc, undefined);
      assert.equal(calls[0].body.bcc, undefined);
    } finally {
      global.fetch = orig;
    }
  });
});
