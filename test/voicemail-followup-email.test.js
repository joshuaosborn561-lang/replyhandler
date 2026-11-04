'use strict';

// Josh, Nov 4 2026: Left a voicemail logs the outcome and opens an editable
// email. Nothing goes to the prospect until Send. Cancel sends nothing.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const replySend = require('../src/services/reply-send');
const vm = require('../src/services/voicemail-followup-email');
const seq = require('../src/services/followup-sequence');

const ROOT = path.join(__dirname, '..');
const DRAFT = 'Hey Prospect, just left you a voicemail. Still want to take a peek at this?';

function stepRow() {
  return {
    id: 'step-1',
    sequence_id: 'seq-1',
    kind: 'call_day0',
    status: 'posted',
    slack_channel: 'C1',
    slack_ts: '1.2',
    payload: {
      card: {
        label: 'Day 0 call',
        leadName: 'Prospect Example',
        phone: '+15555550100',
        script: 'Hello',
      },
    },
  };
}

function seqRow() {
  return {
    id: 'seq-1',
    client_id: 'client-1',
    source_reply_id: 'reply-1',
    status: 'active',
  };
}

function sourceRow() {
  return {
    id: 'reply-1',
    platform: 'smartlead',
    campaign_id: '9',
    campaign_name: 'Example campaign',
    lead_id: '123',
    lead_name: 'Prospect Example',
    lead_full_name: 'Prospect Example',
    lead_company: 'Example Co',
    lead_email: 'prospect@example.test',
    inbound_message: 'Yes, send it over.',
    thread_context: { history: [{ type: 'SENT', email_body: 'Hello from the thread.' }] },
    smartlead_email_stats_id: 'stats1',
  };
}

function clientRow() {
  return {
    id: 'client-1',
    name: 'Example Client',
    slack_bot_token: 'xoxb-test',
    smartlead_api_key: 'test-key',
  };
}

describe('voicemail follow-up email', () => {
  let origSend;
  let origDraft;
  const sends = [];

  beforeEach(() => {
    sends.length = 0;
    origSend = replySend.sendReplyToPlatform;
    origDraft = vm.draftVoicemailFollowUp;
    replySend.sendReplyToPlatform = async (...args) => {
      sends.push(args);
      return {};
    };
  });

  afterEach(() => {
    replySend.sendReplyToPlatform = origSend;
    vm.draftVoicemailFollowUp = origDraft;
  });

  function clickDb() {
    const sqls = [];
    const dbClient = {
      query: async (sql) => {
        sqls.push(sql);
        if (/SET outcome = \$2/.test(sql)) return { rows: [stepRow()] };
        if (/UPDATE followup_sequences/.test(sql)) return { rows: [{ id: 'seq-1' }] };
        if (/FROM followup_sequences WHERE id/.test(sql)) return { rows: [seqRow()] };
        if (/followup_card_events/.test(sql)) return { rows: [] };
        if (/INSERT INTO followup_sequence_steps/.test(sql)) return { rows: [] };
        if (/FROM pending_replies WHERE id/.test(sql)) return { rows: [sourceRow()] };
        if (/slack_bot_token FROM clients/.test(sql)) return { rows: [{ slack_bot_token: 'xoxb-test' }] };
        if (/SELECT \* FROM clients WHERE id/.test(sql)) return { rows: [clientRow()] };
        throw new Error(`unexpected sql: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
      },
    };
    return { dbClient, sqls };
  }

  it('voicemail follow-up email does not send on click or Cancel', async () => {
    vm.draftVoicemailFollowUp = async () => ({ text: DRAFT, source: 'claude' });
    const opened = [];
    const slackApi = {
      getClient: () => ({
        chat: { update: async () => {} },
        views: { open: async (args) => { opened.push(args); return { ok: true }; } },
      }),
    };
    const { dbClient, sqls } = clickDb();
    await seq.handleCallButton(
      { action_id: 'fseq_no_answer', value: 'step-1' },
      {
        trigger_id: 'trig-1',
        user: { id: 'UTEST1' },
        channel: { id: 'C1' },
        message: { ts: '1.2' },
      },
      { dbClient, slackApi, env: { FOLLOWUP_CALLERS: 'UTEST1:Caller' } },
    );

    assert.ok(sqls.some((sql) => /SET outcome = \$2/.test(sql)), 'the click still logs the outcome');
    assert.equal(opened.length, 1);
    const view = opened[0].view;
    assert.equal(view.callback_id, 'fseq_voicemail_email_modal');
    assert.equal(view.submit.text, 'Send');
    assert.equal(view.close.text, 'Cancel');
    const input = view.blocks.find((b) => b.type === 'input');
    assert.equal(input.element.initial_value, DRAFT);
    assert.match(view.blocks[0].text.text, /Nothing is emailed until you click/);
    assert.equal(sends.length, 0, 'opening the modal does not send');

    const errors = vm.validateVoicemailEmailSubmission({
      view: { state: { values: { vm_draft_block: { vm_draft_input: { value: '   ' } } } } },
    });
    assert.ok(errors);
    assert.equal(sends.length, 0, 'an empty Send is rejected and Cancel sends nothing');

    const route = fs.readFileSync(path.join(ROOT, 'src/routes/slack.js'), 'utf8');
    const at = route.indexOf("callback_id === 'fseq_voicemail_email_modal'");
    assert.ok(at > 0);
    const block = route.slice(at, at + 700);
    assert.ok(block.indexOf('validateVoicemailEmailSubmission') < block.indexOf("response_action: 'clear'"));
    assert.doesNotMatch(route, /view_closed[\s\S]{0,180}voicemail/i);
    const sequence = fs.readFileSync(path.join(ROOT, 'src/services/followup-sequence.js'), 'utf8');
    assert.doesNotMatch(sequence, /sendReplyToPlatform|gmail-send/);
  });

  it('Send uses the reply path once, and a second Send does not', async () => {
    let claim = null;
    const dbClient = {
      query: async (sql, params = []) => {
        if (sql.includes("- 'voicemailEmailClaim'")) {
          claim = null;
          return { rows: [] };
        }
        if (sql.includes('voicemailEmailReplyId')) return { rows: [] };
        if (sql.includes('voicemailEmailClaim') && sql.includes("payload->>'voicemailEmailSentAt'")) {
          if (claim) return { rows: [] };
          claim = params[1];
          return { rows: [stepRow()] };
        }
        if (/FROM followup_sequences WHERE id/.test(sql)) return { rows: [seqRow()] };
        if (/FROM pending_replies WHERE id/.test(sql)) return { rows: [sourceRow()] };
        if (/FROM clients WHERE id/.test(sql)) return { rows: [clientRow()] };
        if (/INSERT INTO pending_replies/.test(sql)) {
          assert.equal(params[8], '(voicemail follow-up)');
          assert.equal(params[10], 'Edited follow-up from the modal.');
          return {
            rows: [{
              id: 'vm-reply-1',
              platform: params[1],
              client_id: params[0],
              lead_id: params[4],
              lead_email: params[6],
              classification: 'FOLLOW_UP',
              status: 'approved',
            }],
          };
        }
        if (/SET status = 'sent'/.test(sql)) return { rows: [] };
        if (/SET status = 'failed'/.test(sql)) return { rows: [] };
        throw new Error(`unexpected sql: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
      },
    };
    const submission = {
      user: { id: 'UTEST1' },
      view: {
        callback_id: 'fseq_voicemail_email_modal',
        private_metadata: JSON.stringify({ stepId: 'step-1', channel: 'C1', ts: '1.2' }),
        state: {
          values: {
            vm_draft_block: { vm_draft_input: { value: 'Edited follow-up from the modal.' } },
          },
        },
      },
    };
    const first = await vm.handleVoicemailEmailSubmit(submission, { dbClient });
    assert.equal(first.sent, true);
    assert.equal(first.platform, 'smartlead');
    assert.equal(sends.length, 1);
    assert.equal(sends[0][1].classification, 'FOLLOW_UP');
    assert.equal(sends[0][1].platform, 'smartlead');
    assert.equal(sends[0][2], 'Edited follow-up from the modal.');
    assert.equal(sends[0][3], undefined, 'Send does not CC the client');

    const second = await vm.handleVoicemailEmailSubmit(submission, { dbClient });
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already_sent');
    assert.equal(sends.length, 1);
  });

  it('an ungrounded draft falls back to the short template', async () => {
    const result = await vm.draftVoicemailFollowUp({
      leadName: 'Prospect Example',
      company: 'Example Co',
      inboundMessage: 'Yes, send it over.',
      threadContext: { history: [{ type: 'SENT', email_body: 'Hello from the thread.' }] },
      claudeGenerate: async () => ({ text: 'Hey Prospect, we are based in Denver and just left you a voicemail.' }),
      geminiGenerate: null,
    });
    assert.equal(result.source, 'template');
    assert.doesNotMatch(result.text, /Denver/);
    assert.match(result.text, /just left you a voicemail/);
  });

  it('a slow draft still opens with the template and does not send', async () => {
    vm.draftVoicemailFollowUp = () => new Promise(() => {});
    const opened = [];
    const slackApi = {
      getClient: () => ({
        views: { open: async (args) => { opened.push(args); return { ok: true }; } },
      }),
    };
    const dbClient = {
      query: async (sql) => {
        if (/FROM pending_replies WHERE id/.test(sql)) return { rows: [sourceRow()] };
        if (/FROM clients WHERE id/.test(sql)) return { rows: [clientRow()] };
        throw new Error(sql.slice(0, 80));
      },
    };
    const result = await vm.openFromCallClick({
      step: stepRow(),
      seq: seqRow(),
      interaction: { trigger_id: 'trig-2', channel: { id: 'C1' }, message: { ts: '1.2' } },
      dbClient,
      slackApi,
      draftBudgetMs: 30,
    });
    assert.equal(result.sent, false);
    assert.equal(result.opened, true);
    assert.match(opened[0].view.blocks.find((b) => b.type === 'input').element.initial_value, /just left you a voicemail/);
    assert.equal(sends.length, 0);
  });
});
