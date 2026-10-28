'use strict';

/**
 * Day-30 nurture: pure helpers (no DB, no network).
 *
 * Copy rules follow the approved #nurture email format: no dashes, no free
 * proof-of-concept offer, no AirPods or tickets, the meeting guarantee line,
 * sign-off "Josh Osborn". The proof line is the approved live proof sentence.
 */

const STAGES = Object.freeze(['none', 'day30', 'day90', 'quarterly', 'paused', 'exited']);

/** Touches that have approved copy. Day 90 and quarterly wait for new copy from Research. */
const TOUCH_KINDS_ENABLED = Object.freeze(['day30']);
const TOUCH_KINDS_DISABLED = Object.freeze(['day90', 'quarterly']);

const DAY30_DELAY_DAYS = 30;
const DAY90_GAP_DAYS = 60; // informational date only; the day90 touch stays disabled

const GUARANTEE = 'We guarantee meetings, or we keep working until you hit them.';
const GENERAL_PROOF = '$2M in pipeline last quarter, one client closed $100K in their first 3 months, averaging 14+ replies per month.';
const SIGNOFF = 'Josh Osborn';
const MAX_BODY_WORDS = 110;

const DEFAULT_NURTURE_CHANNEL = 'C0BHBDTMRFY'; // #nurture
const DEFAULT_APPROVER_IDS = Object.freeze(['U0AAX2XFJE7', 'U0BL8JT75KN']); // Josh, Cayden
const DEFAULT_SMARTLEAD_CAMPAIGN_ID = '3122546';
const DEFAULT_HUBSPOT_PORTAL_ID = '245860747';
const HUBSPOT_BASE_URL = 'https://app-na2.hubspot.com';

const ACTION_APPROVE = 'nurture_d30_approve';
const ACTION_EDIT = 'nurture_d30_edit';
const ACTION_SKIP = 'nurture_d30_skip';
const EDIT_MODAL_ID = 'nurture_d30_edit_modal';

/** Replies that mean the lead is talking to us again: pause nurture. */
const POSITIVE_CLASSIFICATIONS = Object.freeze(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);
/** Replies that end nurture for good. */
const EXIT_CLASSIFICATIONS = Object.freeze({
  REMOVE_ME: 'unsubscribed',
  NOT_INTERESTED: 'not_interested',
  WRONG_PERSON: 'wrong_person',
});

const FLAG_TRUE = /^(1|true|yes|on)$/i;

function flag(env, name) {
  return FLAG_TRUE.test(String((env || {})[name] || '').trim());
}

function enabled(env = process.env) { return flag(env, 'NURTURE_ENABLED'); }
function hubspotSyncEnabled(env = process.env) { return flag(env, 'NURTURE_HUBSPOT_SYNC_ENABLED'); }
function postEnabled(env = process.env) { return flag(env, 'NURTURE_POST_ENABLED'); }
function sendEnabled(env = process.env) { return flag(env, 'NURTURE_SEND_ENABLED'); }

function csv(raw) {
  return String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Only these clients' sequences enter nurture. Empty means nobody (safe default). */
function nurtureClientIds(env = process.env) {
  return csv(env.NURTURE_CLIENT_IDS);
}

function approverIds(env = process.env) {
  const ids = csv(env.NURTURE_APPROVER_IDS);
  return ids.length ? ids : [...DEFAULT_APPROVER_IDS];
}

function isApprover(userId, env = process.env) {
  const id = String(userId || '').trim();
  return Boolean(id) && approverIds(env).includes(id);
}

function nurtureChannel(env = process.env) {
  return String(env.NURTURE_SLACK_CHANNEL || '').trim() || DEFAULT_NURTURE_CHANNEL;
}

function smartleadCampaignId(env = process.env) {
  return String(env.SMARTLEAD_NURTURE_CAMPAIGN_ID || '').trim() || DEFAULT_SMARTLEAD_CAMPAIGN_ID;
}

function maxCardsPerDay(env = process.env) {
  const n = parseInt(env.NURTURE_MAX_PER_WEEKDAY, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function day30DelayDays(env = process.env) {
  const n = parseInt(env.NURTURE_DAY30_DELAY_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : DAY30_DELAY_DAYS;
}

/** Sequences that finished before this instant never enter nurture (no back-fill). */
function enrollStart(env = process.env) {
  const raw = String(env.NURTURE_ENROLL_START || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}

function dateOnly(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function chicagoDateLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(d);
}

function firstNameOf(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  return s.replace(/[^A-Za-z'’.-]/g, '');
}

// ─── Draft ────────────────────────────────────────────────────────────────────

function stripDashes(text) {
  return String(text || '').replace(/[—–−]/g, '...');
}

/**
 * The Day 30 email. `repliedAt` is the date of their original positive reply.
 * Nothing in it is invented: the proof line is the approved live proof sentence.
 */
function composeDay30Draft({ leadName, repliedAt, proof = GENERAL_PROOF } = {}) {
  const first = firstNameOf(leadName) || 'there';
  const when = repliedAt ? chicagoDateLabel(repliedAt) : '';
  const opener = when
    ? `Hey ${first}, circling back on your reply from ${when}.`
    : `Hey ${first}, circling back on your reply a few weeks ago.`;
  const body = [
    opener,
    stripDashes(proof),
    GUARANTEE,
    'Worth a look?',
    SIGNOFF,
  ].join('\n\n');
  return { subject: `${first}?`, body };
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Hard validation for the Day 30 email (and for any edit of it).
 * Returns { ok, errors } where errors are short machine codes.
 */
function validateDay30Draft({ subject, body, leadName } = {}) {
  const errors = [];
  const b = String(body || '');
  const s = String(subject || '');
  if (!s.trim()) errors.push('no_subject');
  if (!b.trim()) errors.push('no_body');
  if (/[—–−]/.test(b) || /[—–−]/.test(s)) errors.push('dash');
  if (/\b(free\s+(poc|proof of concept|10k|test list|campaign|audit|trial)|proof of concept|test list)\b/i.test(b)) {
    errors.push('free_poc');
  }
  if (/air\s?pods?|tickets?/i.test(b)) errors.push('airpods_or_tickets');
  if (/[{}]/.test(b) || /[{}]/.test(s)) errors.push('placeholder');
  if (wordCount(b) > MAX_BODY_WORDS) errors.push('too_long');
  if (!b.includes(GUARANTEE)) errors.push('no_guarantee');
  if (!new RegExp(`${SIGNOFF}\\s*$`).test(b.trim())) errors.push('no_signature');
  if (/^hey\s+there\b/i.test(b.trim()) && leadName) errors.push('no_first_name');
  return { ok: errors.length === 0, errors };
}

// ─── HubSpot ──────────────────────────────────────────────────────────────────

/** Contact properties the system reads and writes. Created by scripts/hubspot-nurture-properties.js. */
const HUBSPOT_PROPERTIES = Object.freeze([
  {
    name: 'nurture_stage',
    label: 'Nurture stage',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: STAGES.map((value, i) => ({ label: value, value, displayOrder: i, hidden: false })),
  },
  { name: 'nurture_next_touch_date', label: 'Nurture next touch date', type: 'date', fieldType: 'date', groupName: 'contactinformation' },
  { name: 'last_outreach_date', label: 'Last outreach date', type: 'date', fieldType: 'date', groupName: 'contactinformation' },
  { name: 'nurture_exit_reason', label: 'Nurture exit reason', type: 'string', fieldType: 'text', groupName: 'contactinformation' },
]);

function hubspotContactUrl(contactId, env = process.env) {
  if (!contactId) return null;
  const portal = String(env.HUBSPOT_PORTAL_ID || '').trim() || DEFAULT_HUBSPOT_PORTAL_ID;
  return `${HUBSPOT_BASE_URL}/contacts/${portal}/record/0-1/${encodeURIComponent(contactId)}`;
}

/** The four contact properties for one nurture row. Empty string clears a value in HubSpot. */
function hubspotPropsFor(lead) {
  return {
    nurture_stage: lead.stage || 'none',
    nurture_next_touch_date: lead.next_touch_at ? dateOnly(lead.next_touch_at) : '',
    last_outreach_date: lead.last_outreach_at ? dateOnly(lead.last_outreach_at) : '',
    nurture_exit_reason: lead.exit_reason || '',
  };
}

function hubspotStateKey(lead) {
  const p = hubspotPropsFor(lead);
  return [p.nurture_stage, p.nurture_next_touch_date, p.last_outreach_date, p.nurture_exit_reason].join('|');
}

// ─── Slack card ───────────────────────────────────────────────────────────────

function mrkdwnEscape(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * The #nurture card. Tagged NURTURE. Buttons carry the touch id.
 * `state` is null while open, or { label, by } once someone acted on it.
 */
function buildNurtureCardBlocks(card, touchId, state = null) {
  const lines = [
    `*Name:* ${mrkdwnEscape(card.name || 'Unknown')}`,
    `*Company:* ${mrkdwnEscape(card.company || 'Unknown')}`,
    `*Last outreach:* ${card.lastOutreach ? mrkdwnEscape(card.lastOutreach) : 'Unknown'}`,
    card.phone
      ? `*Phone:* ${mrkdwnEscape(card.phone)}`
      : `*Phone:* none found${card.phoneNote ? ` (${mrkdwnEscape(card.phoneNote)})` : ''}`,
    `*Last reply or call:* ${card.summary ? mrkdwnEscape(clip(card.summary, 500)) : 'No summary on file'}`,
    card.hubspotUrl ? `*HubSpot:* <${card.hubspotUrl}|Open contact>` : '*HubSpot:* no contact found',
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `NURTURE: Day 30 touch` } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
  if (card.callMention) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Call task: ${card.callMention} ${card.phone ? 'calls this lead' : 'needs a number first'}.` }],
    });
  }
  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Email that will send*\n*To:* ${mrkdwnEscape(card.email || '')}\n*Subject:* ${mrkdwnEscape(card.subject || '')}\n\`\`\`${String(card.body || '').replace(/```/g, "'''")}\`\`\``,
      },
    },
  );
  if (state) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${state.label}${state.by ? ` by <@${state.by}>` : ''}` }] });
  } else {
    blocks.push({
      type: 'actions',
      block_id: `nurture_d30_${touchId}`,
      elements: [
        { type: 'button', style: 'primary', action_id: ACTION_APPROVE, value: String(touchId), text: { type: 'plain_text', text: 'Approve & Send' } },
        { type: 'button', action_id: ACTION_EDIT, value: String(touchId), text: { type: 'plain_text', text: 'Edit & send' } },
        { type: 'button', style: 'danger', action_id: ACTION_SKIP, value: String(touchId), text: { type: 'plain_text', text: 'Skip' } },
      ],
    });
  }
  return blocks;
}

function buildEditModal({ touchId, channel, ts, subject, body }) {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL_ID,
    private_metadata: JSON.stringify({ touchId, channel, ts }),
    title: { type: 'plain_text', text: 'Edit nurture email' },
    submit: { type: 'plain_text', text: 'Save & send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'subject_block', label: { type: 'plain_text', text: 'Subject' },
        element: { type: 'plain_text_input', action_id: 'subject_input', initial_value: String(subject || '').slice(0, 300) },
      },
      {
        type: 'input', block_id: 'body_block', label: { type: 'plain_text', text: 'Body' },
        element: { type: 'plain_text_input', action_id: 'body_input', multiline: true, initial_value: String(body || '').slice(0, 2900) },
      },
    ],
  };
}

module.exports = {
  STAGES,
  TOUCH_KINDS_ENABLED,
  TOUCH_KINDS_DISABLED,
  DAY90_GAP_DAYS,
  GUARANTEE,
  GENERAL_PROOF,
  SIGNOFF,
  POSITIVE_CLASSIFICATIONS,
  EXIT_CLASSIFICATIONS,
  ACTION_APPROVE,
  ACTION_EDIT,
  ACTION_SKIP,
  EDIT_MODAL_ID,
  HUBSPOT_PROPERTIES,
  enabled,
  hubspotSyncEnabled,
  postEnabled,
  sendEnabled,
  nurtureClientIds,
  approverIds,
  isApprover,
  nurtureChannel,
  smartleadCampaignId,
  maxCardsPerDay,
  day30DelayDays,
  enrollStart,
  addDays,
  dateOnly,
  chicagoDateLabel,
  firstNameOf,
  composeDay30Draft,
  validateDay30Draft,
  hubspotContactUrl,
  hubspotPropsFor,
  hubspotStateKey,
  buildNurtureCardBlocks,
  buildEditModal,
};
