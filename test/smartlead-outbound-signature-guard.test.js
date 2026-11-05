const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  prepareSmartleadReplyText,
  shouldAppendSmartleadMailboxSignature,
} = require('../src/utils/smartlead-outbound-body');
const {
  validateSmartleadOutboundSignature,
  isOutboundSignatureGuardError,
  OutboundSignatureGuardError,
  signatureGuardUserMessage,
  simulateAgencyOutboundPlain,
} = require('../src/utils/smartlead-outbound-signature-guard');
const { resetAgencySignatureContractCacheForTests } = require('../src/utils/smartlead-agency-signature-contract');
const smartlead = require('../src/services/smartlead');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CIOTOLA = { name: 'Jeremy Ciotola' };
const PARLAY = { name: 'Parlay Tech' };
const JEREMY_INBOX = 'jciotola@getjeremyciotola.info';
const PARLAY_INBOX = 'myles@parlaytech.io';
const AGENCY_INBOX = 'joshua@salesglidergrowth.com';

const CONTRACT_ENV_KEY = 'SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON';
const VERIFIED_AGENCY_CONTRACT = {
  [AGENCY_INBOX]: 'Joshua Osborn\nSalesGlider Growth',
};

let savedContractEnv;

test.beforeEach(() => {
  savedContractEnv = process.env[CONTRACT_ENV_KEY];
  process.env[CONTRACT_ENV_KEY] = JSON.stringify(VERIFIED_AGENCY_CONTRACT);
  resetAgencySignatureContractCacheForTests();
});

test.afterEach(() => {
  if (savedContractEnv === undefined) delete process.env[CONTRACT_ENV_KEY];
  else process.env[CONTRACT_ENV_KEY] = savedContractEnv;
  resetAgencySignatureContractCacheForTests();
});

/**
 * Repository fixture matrix (campaign-routing owner slugs + synthetic inboxes).
 * Not a live Smartlead mailbox inventory audit — no Smartlead API calls.
 */
const CLIENT_POD_MATRIX = [
  { label: 'Ciotola', client: CIOTOLA, inbox: JEREMY_INBOX, expectedSignOff: 'Jeremy' },
  { label: 'Parlay', client: PARLAY, inbox: PARLAY_INBOX, expectedSignOff: 'Myles' },
  { label: 'Culture Fits (synthetic inbox)', client: { name: 'Alex Turner' }, inbox: 'alex@culturefits.io', expectedSignOff: 'Alex' },
  { label: 'BCP person-style', client: { name: 'Randy BCP' }, inbox: 'randy@boldercyber.test', expectedSignOff: 'Randy' },
  { label: 'Company-only name (no derive)', client: { name: 'Nexus Group' }, inbox: 'info@nexusgroup.test', expectCode: 'CANNOT_DERIVE_SIGNOFF' },
];

const TREVOR_DRAFT = [
  'Hi Trevor, thanks so much, I really appreciate that. I\'d love it if you\'d reach out to those churches, and feel free to share my info or connect us directly. Thanks again!',
  '',
  'Jeremy',
].join('\n');

function validatePreparedClientSend(replyText, client, inbox) {
  const plainBody = prepareSmartleadReplyText(replyText, { client, sendingInboxEmail: inbox });
  const appendSig = shouldAppendSmartleadMailboxSignature({ sendingInboxEmail: inbox });
  return validateSmartleadOutboundSignature({
    plainBody,
    emailBody: plainBody,
    addSignature: appendSig,
    outboundClient: client,
    sendingInboxEmail: inbox,
  });
}

test('Trevor Ciotola Slack draft prepares to a single Jeremy sign-off (fixture replay)', () => {
  const plain = prepareSmartleadReplyText(TREVOR_DRAFT, {
    client: CIOTOLA,
    sendingInboxEmail: JEREMY_INBOX,
  });
  assert.match(plain, /Thanks again!$/m);
  assert.match(plain, /\n\nJeremy$/);
  assert.doesNotMatch(plain, /SalesGlider/i);
  validatePreparedClientSend(TREVOR_DRAFT, CIOTOLA, JEREMY_INBOX);
});

test('table: client pod signature matrix (fixture configs only, not live inbox inventory)', () => {
  for (const row of CLIENT_POD_MATRIX) {
    if (row.expectCode) {
      const plain = prepareSmartleadReplyText('Quick note.', {
        client: row.client,
        sendingInboxEmail: row.inbox,
      });
      assert.throws(
        () => validateSmartleadOutboundSignature({
          plainBody: plain,
          emailBody: plain,
          addSignature: false,
          outboundClient: row.client,
          sendingInboxEmail: row.inbox,
        }),
        (err) => err.code === row.expectCode,
        row.label,
      );
      continue;
    }
    const draft = `Body for ${row.label}.\n\nBest,\n${row.expectedSignOff}`;
    const plain = prepareSmartleadReplyText(draft, {
      client: row.client,
      sendingInboxEmail: row.inbox,
    });
    assert.match(plain, new RegExp(`\\n\\n${row.expectedSignOff}$`));
    validateSmartleadOutboundSignature({
      plainBody: plain,
      emailBody: plain,
      addSignature: false,
      outboundClient: row.client,
      sendingInboxEmail: row.inbox,
    });
  }
});

test('rejects stacked historical Ciotola footer pattern in outbound body', () => {
  const stacked = [
    'Sounds good.',
    'Jeremy',
    'Jeremy',
    'Jeremy Ciotola',
    'SalesGlider',
  ].join('\n');
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: stacked,
      emailBody: stacked,
      addSignature: false,
      outboundClient: CIOTOLA,
      sendingInboxEmail: JEREMY_INBOX,
    }),
    (err) => err.code === 'CLIENT_DUPLICATE_NAMES' || err.code === 'CLIENT_AGENCY_FOOTER',
  );
});

test('rejects client pod with add_signature true (SalesGlider footer path)', () => {
  const plain = 'Hello there.\n\nJeremy';
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: plain,
      emailBody: plain,
      addSignature: true,
      outboundClient: CIOTOLA,
      sendingInboxEmail: JEREMY_INBOX,
    }),
    (err) => err.code === 'CLIENT_ADD_SIGNATURE_ON',
  );
});

test('agency: verified contract + clean body simulates a single mailbox signature block', () => {
  const plain = prepareSmartleadReplyText('Thursday works.\n\nJosh', {
    client: { name: 'SalesGlider' },
    sendingInboxEmail: AGENCY_INBOX,
  });
  assert.equal(plain, 'Thursday works.');
  const result = validateSmartleadOutboundSignature({
    plainBody: plain,
    emailBody: plain,
    addSignature: true,
    outboundClient: { name: 'SalesGlider' },
    sendingInboxEmail: AGENCY_INBOX,
  });
  assert.equal(result.mode, 'agency');
  assert.match(result.simulatedOutboundPlain, /Thursday works\.\n\nJoshua Osborn\nSalesGlider Growth$/);
});

test('agency: draft sign-off in body fails combined validation', () => {
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: 'Thursday works.\n\nJosh',
      emailBody: 'Thursday works.\n\nJosh',
      addSignature: true,
      outboundClient: { name: 'SalesGlider' },
      sendingInboxEmail: AGENCY_INBOX,
      agencySignatureContractPlain: VERIFIED_AGENCY_CONTRACT[AGENCY_INBOX],
    }),
    (err) => err.code === 'AGENCY_BODY_SIGNOFF',
  );
});

test('agency: unverified mailbox (no contract) fails closed', () => {
  delete process.env[CONTRACT_ENV_KEY];
  resetAgencySignatureContractCacheForTests();
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: 'Hello.',
      emailBody: 'Hello.',
      addSignature: true,
      outboundClient: { name: 'SalesGlider' },
      sendingInboxEmail: AGENCY_INBOX,
    }),
    (err) => err.code === 'AGENCY_SIGNATURE_UNVERIFIED',
  );
});

test('agency: contaminated signature contract (duplicate names) fails closed', () => {
  const badContract = 'Jeremy\nJeremy\nJeremy Ciotola\nSalesGlider Growth';
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: 'Hello.',
      emailBody: 'Hello.',
      addSignature: true,
      outboundClient: { name: 'SalesGlider' },
      sendingInboxEmail: AGENCY_INBOX,
      agencySignatureContractPlain: badContract,
    }),
    (err) => err.code === 'AGENCY_SIGNATURE_CONTRACT_DUPLICATE',
  );
});

test('missing sending inbox never bypasses the guard', () => {
  assert.throws(
    () => validateSmartleadOutboundSignature({
      plainBody: 'Hi.\n\nJeremy',
      emailBody: 'Hi.\n\nJeremy',
      addSignature: false,
      outboundClient: CIOTOLA,
      sendingInboxEmail: '',
    }),
    (err) => err.code === 'MISSING_SENDING_INBOX',
  );
});

test('greeting with recipient name is not treated as a stacked signature', () => {
  const plain = prepareSmartleadReplyText(
    'Hi Trevor, thanks for connecting.\n\nJeremy',
    { client: CIOTOLA, sendingInboxEmail: JEREMY_INBOX },
  );
  validateSmartleadOutboundSignature({
    plainBody: plain,
    emailBody: plain,
    addSignature: false,
    outboundClient: CIOTOLA,
    sendingInboxEmail: JEREMY_INBOX,
  });
});

test('HTML outbound body is validated after formatting', () => {
  const plain = prepareSmartleadReplyText('Sure.\n\nMyles', {
    client: PARLAY,
    sendingInboxEmail: PARLAY_INBOX,
  });
  const html = plain.replace(/\n\n/g, '<br/><br/>').replace(/\n/g, '<br/>');
  validateSmartleadOutboundSignature({
    plainBody: plain,
    emailBody: html,
    addSignature: false,
    outboundClient: PARLAY,
    sendingInboxEmail: PARLAY_INBOX,
  });
});

test('SmartLead sendReply: signature guard blocks POST with zero provider calls', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, text: async () => '{}' };
  };
  try {
    await assert.rejects(
      () => smartlead.sendReply('test-key', 1, 2, {
        replyText: TREVOR_DRAFT,
        emailStatsId: 'stats-1',
        outboundClient: CIOTOLA,
        sendingInboxEmail: '',
      }),
      (err) => isOutboundSignatureGuardError(err),
    );
    assert.equal(calls.length, 0);

    delete process.env[CONTRACT_ENV_KEY];
    resetAgencySignatureContractCacheForTests();
    await assert.rejects(
      () => smartlead.sendReply('test-key', 9, 8, {
        replyText: 'Agency line.',
        emailStatsId: 'stats-agency-fail',
        outboundClient: { name: 'SalesGlider' },
        sendingInboxEmail: AGENCY_INBOX,
      }),
      (err) => err.code === 'AGENCY_SIGNATURE_UNVERIFIED',
    );
    assert.equal(calls.length, 0);

    process.env[CONTRACT_ENV_KEY] = JSON.stringify(VERIFIED_AGENCY_CONTRACT);
    resetAgencySignatureContractCacheForTests();

    calls.length = 0;
    await smartlead.sendReply('test-key', 1, 2, {
      replyText: TREVOR_DRAFT,
      emailStatsId: 'stats-3',
      outboundClient: CIOTOLA,
      sendingInboxEmail: JEREMY_INBOX,
    });
    assert.equal(calls.length, 1);

    calls.length = 0;
    await smartlead.sendReply('test-key', 3739758, 33, {
      replyText: 'Thursday works.\n\nJosh',
      emailStatsId: 'stats-4',
      outboundClient: { name: 'SalesGlider' },
      sendingInboxEmail: AGENCY_INBOX,
    });
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).add_signature, true);
  } finally {
    global.fetch = orig;
  }
});

test('recovery: flagged rows stay claimable for approve/edit/stuck retry (no duplicate card path)', () => {
  const dedupe = read('src/services/reply-dedupe.js');
  assert.match(dedupe, /claimable = \['pending', 'flagged', 'approved', 'failed'\]/);
  const slack = read('src/routes/slack.js');
  assert.match(slack, /flagSignatureBlockedCard/);
  assert.match(slack, /status = 'flagged', send_error/);
  const approveCatch = slack.slice(slack.indexOf('Failed to send reply after approval'));
  assert.doesNotMatch(approveCatch.slice(0, 600), /status = 'sent'/);
  assert.match(read('src/services/stuck-send-sweeper.js'), /sendReplyToPlatform/);
});

test('smartlead.js validates outbound signature before fetch', () => {
  const src = read('src/services/smartlead.js');
  const validateAt = src.indexOf('validateSmartleadOutboundSignature');
  const fetchAt = src.indexOf('const res = await fetch(url', validateAt);
  assert.ok(validateAt > 0 && fetchAt > validateAt);
  assert.match(src, /resolveAgencySignatureContract/);
});

test('simulateAgencyOutboundPlain matches verified contract append only', () => {
  const combined = simulateAgencyOutboundPlain('Body.', VERIFIED_AGENCY_CONTRACT[AGENCY_INBOX]);
  assert.equal(combined, 'Body.\n\nJoshua Osborn\nSalesGlider Growth');
});

test('OutboundSignatureGuardError exposes user-facing message', () => {
  const err = new OutboundSignatureGuardError('TEST', 'internal', 'Fix the draft sign-off.');
  assert.equal(signatureGuardUserMessage(err), 'Fix the draft sign-off.');
});
