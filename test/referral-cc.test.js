const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { promoteReferral } = require('../src/routes/webhooks');
const { buildDraftApprovalCard, buildEditReplyBlocks } = require('../src/services/slack');
const { fallbackDraftText } = require('../src/services/classifier');
const smartlead = require('../src/services/smartlead');
const {
  extractReferredContacts,
  parseReferralCcInput,
  referralCcButtonText,
} = require('../src/utils/referred-contact');

const PROSPECT = 'ariel@orioncityscape.com';
const OURS = ['gracev@vectorenergyrun.info'];
const OPTS = {
  prospectEmail: PROSPECT,
  prospectName: 'Ariel Isaac Franco',
  ourEmails: OURS,
};

// Ariel Isaac Franco, Vector | Big Owners | Clippers, 10:57 AM ET Oct 27 2026.
// Human sentence names Guy and types Guy@. Signature and quoted outbound do not.
const ARIEL_HTML = [
  '<div dir="ltr">Hi please talk to Guy at our office. ',
  '<a href="mailto:Guy@orioncityscape.com">Guy@orioncityscape.com</a><br></div>',
  '<div data-smartmail="gmail_signature">',
  '<div>Ariel Isaac Franco</div>',
  '<div>Orion Cityscape</div>',
  '<div>E: <a href="mailto:Ariel@orioncityscape.com">Ariel@orioncityscape.com</a></div>',
  '<div>C: +1.310.873.7418</div>',
  '</div>',
  '<div class="gmail_quote">',
  'On Tue, Oct 27, 2026, 07:23 Grace Vance &lt;gracev@vectorenergyrun.info&gt; wrote:<br>',
  '<div>Clippers tix. Reach tickets@vectorenergyrun.info if you want seats.</div>',
  '</div>',
].join('');

const ARIEL_PLAIN = [
  'Hi please talk to Guy at our office. Guy@orioncityscape.com',
  '',
  'Ariel Isaac Franco',
  'Orion Cityscape',
  'E: Ariel@orioncityscape.com',
  'C: +1.310.873.7418',
  '',
  'On Tue, Oct 27, 2026, 07:23 Grace Vance <gracev@vectorenergyrun.info> wrote:',
  'Clippers tix. Reach tickets@vectorenergyrun.info if you want seats.',
].join('\n');

const NAME_ONLY = 'Hi please talk to Guy at our office.';

const DISCLAIMER = [
  'Disclaimer',
  'The information contained in this communication from the sender is confidential. It is intended solely for use by the recipient and others authorized to receive it. If you are not the recipient, you are hereby notified that any disclosure, copying, distribution or taking action in relation of the contents of this information is strictly prohibited and may be unlawful. Questions go to privacy@orioncityscape.com.',
  '',
  'This email has been scanned for viruses and malware, and may have been automatically archived by Mimecast, a leader in email security and cyber resilience. Mimecast integrates email defenses with brand protection, security awareness training, web security, compliance and other essential capabilities. Mimecast helps protect large and small organizations from malicious activity, human error and technology failure; and to lead the movement toward building a more resilient world. To find out more, visit our website.',
].join('\n');

function emailsOf(raw, opts = OPTS) {
  return extractReferredContacts(raw, opts).map((c) => c.email);
}

function cardJson(inbound, referredContacts, extra = {}) {
  return JSON.stringify(buildDraftApprovalCard({
    replyId: 'ariel-row',
    leadName: 'Ariel Isaac Franco',
    leadEmail: PROSPECT,
    platform: 'smartlead',
    classification: 'INTERESTED',
    draft: 'Hey Ariel, thanks for pointing me to Guy.',
    reasoning: 'Referral reply.',
    inboundMessage: inbound,
    campaignDisplay: 'Vector | Big Owners | Clippers (4242292)',
    referredContacts,
    ...extra,
  }));
}

describe('referral CC is only an address the prospect typed', () => {
  it('Ariel HTML detects Guy@ and not the signature or the quoted sender', () => {
    const contacts = extractReferredContacts(ARIEL_HTML, OPTS);
    assert.deepEqual(contacts.map((c) => c.email), ['Guy@orioncityscape.com']);
    assert.equal(contacts[0].name, 'Guy');
    assert.equal(emailsOf(ARIEL_PLAIN).join(','), 'Guy@orioncityscape.com');
  });

  it('a lone address above the signature stays, and the address under the name does not', () => {
    const body = [
      'Hi please talk to Guy at our office.',
      'Guy@orioncityscape.com',
      '',
      'Ariel Isaac Franco',
      'Orion Cityscape',
      'Ariel@orioncityscape.com',
      '+1.310.873.7418',
    ].join('\n');
    assert.deepEqual(emailsOf(body), ['Guy@orioncityscape.com']);
  });

  it('does not take an address from a signature, a quote, a disclaimer, or a mailto label', () => {
    const signatureOnly = [
      'Hi please talk to Guy at our office.',
      '',
      'Ariel Isaac Franco',
      'Orion Cityscape',
      'assistant@orioncityscape.com',
      '+1.310.873.7418',
    ].join('\n');
    assert.deepEqual(emailsOf(signatureOnly), []);

    const quoted = [
      'Hi please talk to Guy at our office.',
      '',
      'On Tue, Oct 27, 2026, 07:23 Grace Vance <gracev@vectorenergyrun.info> wrote:',
      'Talk to Guy at Guy@orioncityscape.com',
    ].join('\n');
    assert.deepEqual(emailsOf(quoted), []);

    const disclaimer = `Hi please talk to Guy at our office.\n\n${DISCLAIMER}`;
    assert.deepEqual(emailsOf(disclaimer), []);

    const labelOnly = 'Hi please talk to <a href="mailto:Guy@orioncityscape.com">Guy</a> at our office.';
    assert.deepEqual(emailsOf(labelOnly), []);
  });

  it('does not construct an address from a name or a domain', () => {
    assert.deepEqual(emailsOf('Hi please talk to Guy at our office.'), []);
    assert.deepEqual(emailsOf('Hi please talk to Guy at orioncityscape.com.'), []);
    assert.deepEqual(emailsOf("Please contact Jane instead."), []);
    assert.deepEqual(emailsOf("I've CC'd our ops manager."), []);
  });

  it('keeps every typed address except the prospect and our senders', () => {
    const body = 'Please talk to Guy at Guy@orioncityscape.com and Sam at Sam@orioncityscape.com. I am ariel@orioncityscape.com.';
    const found = emailsOf(`${body}\n\nAlso gracev@vectorenergyrun.info wrote earlier.`);
    assert.deepEqual(found, ['Guy@orioncityscape.com', 'Sam@orioncityscape.com']);
  });

  it('an email referral is carded from Not Interested and Wrong Person', () => {
    const ni = promoteReferral('NOT_INTERESTED', ARIEL_HTML, OPTS);
    assert.equal(ni.promoted, true);
    assert.equal(ni.classification, 'INTERESTED');
    assert.deepEqual(ni.referredContacts.map((c) => c.email), ['Guy@orioncityscape.com']);

    const wp = promoteReferral('WRONG_PERSON', 'Please talk to Sam instead. Sam@orioncityscape.com', OPTS);
    assert.equal(wp.promoted, true);
    assert.equal(wp.classification, 'INTERESTED');
    assert.equal(wp.referredContacts[0].email, 'Sam@orioncityscape.com');

    const already = promoteReferral('QUESTION', ARIEL_PLAIN, OPTS);
    assert.equal(already.promoted, false);
    assert.equal(already.classification, 'QUESTION');
    assert.equal(already.referredContacts[0].email, 'Guy@orioncityscape.com');
  });

  it('a name with no email stays on the old path', () => {
    assert.equal(promoteReferral('OTHER', NAME_ONLY, OPTS).promoted, true);
    assert.deepEqual(promoteReferral('OTHER', NAME_ONLY, OPTS).referredContacts, []);
    assert.equal(promoteReferral('WRONG_PERSON', 'Please talk to Sam instead', OPTS).promoted, false);
    assert.equal(promoteReferral('NOT_INTERESTED', "I've CC'd our ops manager", OPTS).promoted, false);
    assert.equal(promoteReferral('QUESTION', "I've cc'd X", OPTS).promoted, false);
    assert.deepEqual(promoteReferral('QUESTION', "I've cc'd X", OPTS).referredContacts, []);
    assert.equal(promoteReferral('REMOVE_ME', 'Stop. Talk to Guy at Guy@orioncityscape.com', OPTS).promoted, false);
    assert.equal(
      promoteReferral('OTHER', "I am out of the office until Monday. Talk to Guy at Guy@orioncityscape.com", OPTS).promoted,
      false,
    );
  });

  it('the card shows the full reply and the CC action for Guy@', () => {
    const shown = cardJson(ARIEL_PLAIN, extractReferredContacts(ARIEL_PLAIN, OPTS));
    assert.match(shown, /Hi please talk to Guy at our office/);
    assert.match(shown, /Guy@orioncityscape\.com/);
    assert.match(shown, /Ariel Isaac Franco/);
    assert.match(shown, /Referred contact/);
    assert.match(shown, /approve_reply_cc_referral/);
    assert.match(shown, /Approve & send with CC Guy@orioncityscape\.com/);
    assert.match(shown, /"action_id":"approve_reply"/);
    assert.equal(referralCcButtonText([{ email: 'Guy@orioncityscape.com' }]).length <= 75, true);
  });

  it('a name with no email has no CC option', () => {
    const withSignature = [
      NAME_ONLY,
      '',
      'Ariel Isaac Franco',
      'Orion Cityscape',
      'assistant@orioncityscape.com',
      '+1.310.873.7418',
    ].join('\n');
    const contacts = extractReferredContacts(withSignature, OPTS);
    assert.deepEqual(contacts, []);
    const shown = cardJson(withSignature, contacts);
    assert.match(shown, /Hi please talk to Guy at our office/);
    assert.match(shown, /assistant@orioncityscape\.com/);
    assert.match(shown, /"action_id":"approve_reply"/);
    assert.match(shown, /"action_id":"reject_reply"/);
    assert.doesNotMatch(shown, /approve_reply_cc_referral/);
    assert.doesNotMatch(shown, /Referred contact/);
    assert.doesNotMatch(shown, /CC address/);

    const edit = JSON.stringify(buildEditReplyBlocks({ initialDraft: 'Hey Ariel' }));
    assert.doesNotMatch(edit, /referral_cc_block/);
    assert.doesNotMatch(edit, /referral_cc_input/);
  });

  it('HeyReach does not grow a CC button from a referred email', () => {
    const shown = cardJson(ARIEL_PLAIN, [{ name: 'Guy', email: 'Guy@orioncityscape.com' }], {
      platform: 'heyreach',
    });
    assert.doesNotMatch(shown, /approve_reply_cc_referral/);
  });

  it('edit can change or clear the CC, and a bad address sends nothing', () => {
    const blocks = buildEditReplyBlocks({
      initialDraft: 'Hey Ariel, thanks for pointing me to Guy.',
      referralCc: 'Guy@orioncityscape.com',
    });
    const cc = blocks.find((b) => b.block_id === 'referral_cc_block');
    assert.ok(cc);
    assert.equal(cc.optional, true);
    assert.equal(cc.element.initial_value, 'Guy@orioncityscape.com');

    const changed = parseReferralCcInput('Sam@orioncityscape.com', OPTS);
    assert.deepEqual(changed.emails, ['Sam@orioncityscape.com']);
    const cleared = parseReferralCcInput('   ', OPTS);
    assert.deepEqual(cleared.emails, []);
    assert.equal(cleared.error, undefined);
    const garbage = parseReferralCcInput('Guy at the office', OPTS);
    assert.match(garbage.error, /Nothing was sent/);
    const own = parseReferralCcInput(PROSPECT, OPTS);
    assert.match(own.error, /Nothing was sent/);
    assert.equal(own.emails, undefined);
  });

  it('the fallback is the fixed referral template and does not invent an address', () => {
    const expected = 'Thank you so much for the contact, Ariel!\n\nHey Guy, would this be worth meeting about for you?';
    const draft = fallbackDraftText({
      leadName: 'Ariel Isaac Franco',
      classification: 'INTERESTED',
      inboundMessage: ARIEL_PLAIN,
      referredContacts: [{ name: 'Guy', email: 'Guy@orioncityscape.com' }],
      bookingLink: 'https://book.example.com/josh',
      includeBookingLink: true,
      clientName: 'Deep Roots',
    });
    assert.equal(draft, expected);
    assert.doesNotMatch(draft, /book\.example\.com/);
    assert.doesNotMatch(draft, /218-469-3457/);

    const named = fallbackDraftText({
      leadName: 'Ariel Isaac Franco',
      classification: 'INTERESTED',
      inboundMessage: NAME_ONLY,
    });
    assert.equal(named, expected);
    assert.doesNotMatch(named, /Guy@/);
  });

  it('SmartLead CC send posts once, and a missing CC does not send', async () => {
    const calls = [];
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, text: async () => JSON.stringify({ success: true }) };
    };
    try {
      await smartlead.sendReply('test-key', 4242292, 4826394148, {
        replyText: 'Hey Ariel, thanks for pointing me to Guy.',
        emailStatsId: 'b0b7bc9d-364b-4fe9-85be-a1f0bff77845',
        cc: 'Guy@orioncityscape.com',
        requireCc: true,
        requiredCc: ['Guy@orioncityscape.com'],
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/campaigns\/4242292\/reply-email-thread/);
      assert.equal(calls[0].body.cc, 'Guy@orioncityscape.com');
      assert.equal(typeof calls[0].body.cc, 'string');
      assert.equal(calls[0].body.email_stats_id, 'b0b7bc9d-364b-4fe9-85be-a1f0bff77845');

      calls.length = 0;
      await assert.rejects(
        () => smartlead.sendReply('test-key', 4242292, 4826394148, {
          replyText: 'Hey Ariel',
          emailStatsId: 'stats-1',
          requireCc: true,
          requiredCc: ['Guy@orioncityscape.com'],
        }),
        /Nothing was sent/,
      );
      assert.equal(calls.length, 0);

      await assert.rejects(
        () => smartlead.sendReply('test-key', 4242292, 4826394148, {
          replyText: 'Hey Ariel',
          emailStatsId: 'stats-1',
          cc: ['Guy@orioncityscape.com'],
          requireCc: true,
          requiredCc: ['Guy@orioncityscape.com'],
        }),
        /Nothing was sent/,
      );
      assert.equal(calls.length, 0);
    } finally {
      global.fetch = orig;
    }
  });
});
