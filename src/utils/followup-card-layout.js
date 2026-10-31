'use strict';

/**
 * Follow-up card layout (Josh, Oct 31 2026).
 *
 * One shape for call, email, and no-show cards:
 *   1. action · sequence step · why
 *   2. campaign, who they are, local time, phone / email / LinkedIn
 *   3. ICP (the Jev website check) and decision maker
 *   4. the script, or only our last message, their last message, and the draft
 *   5. buttons
 *   6. one context line
 *
 * No client-name header. The full thread and the lead's card history open
 * from "View full thread & history".
 */

function slackApi() {
  return require('../services/slack');
}

const DAY_OF_FIVE = {
  call_day0: 1,
  call_day0_late: 1,
  email_vm: 1,
  call_day1: 2,
  email_day1: 2,
  call_day3: 3,
  email_proof: 3,
  email_thoughts: 4,
  email_breakup: 5,
  call_day6: 5,
};

const CALL_ACTIONS = [
  { actionId: 'fseq_booked', text: '✅ Booked', style: 'primary' },
  { actionId: 'fseq_no_answer', text: '📵 No answer / Left VM' },
  { actionId: 'fseq_call_back', text: '🔁 Call back' },
  { actionId: 'fseq_snooze', text: 'Snooze' },
  { actionId: 'fseq_not_interested', text: 'Not interested', style: 'danger' },
];

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function variantOf(card) {
  if (card && card.variant) return card.variant;
  const kind = String((card && card.kind) || '');
  if (kind === 'ghost_email' || kind === 'ghost_email_2' || kind === 'ghost_breakup') return 'noshow';
  if (kind.startsWith('ghost_call') || kind.startsWith('call')) return 'call';
  const meeting = card && (card.meeting || (card.context && card.context.meeting));
  if (meeting && /no-show/i.test(`${meeting.label || ''} ${meeting.text || ''}`)) return 'noshow';
  if (card && (card.script || card.scriptParts) && !card.draft) return 'call';
  return 'email';
}

function dayPhrase(kind) {
  const n = DAY_OF_FIVE[kind];
  return n ? `Day ${n} of 5` : '';
}

function actionPhrase(card, variant) {
  if (variant === 'noshow') return '↩️ *Rebook no-show*';
  if (variant === 'call') return '📞 *Call today*';
  return '✉️ *Send follow-up*';
}

function weekdayOf(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', weekday: 'short' }).format(d);
  } catch {
    return '';
  }
}

function quoteBit(text, max = 70) {
  const t = clean(text).replace(/^["“]|["”]$/g, '');
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function whyLine(card, variant) {
  if (card && card.why) return clean(card.why);
  const meeting = card && (card.meeting || (card.context && card.context.meeting));
  if (variant === 'noshow') {
    return meeting && meeting.text ? `missed ${clean(meeting.text)}` : 'missed the meeting';
  }
  if (variant === 'email') {
    const dow = card && card.priorCallDow ? clean(card.priorCallDow) : '';
    return dow ? `no answer to call ${dow}` : 'no answer';
  }
  const said = quoteBit(card && (card.theirText || (card.context && card.context.replyExcerpt) || (card.context && card.context.reply)));
  const dow = card && card.theirAt ? weekdayOf(card.theirAt, card.tz) : '';
  if (said && dow) return `went quiet after "${said}" on ${dow}`;
  if (said) return `went quiet after "${said}"`;
  return 'went quiet';
}

function headlineText(card) {
  const variant = variantOf(card);
  const parts = [actionPhrase(card, variant), dayPhrase(card && card.kind), whyLine(card, variant)].filter(Boolean);
  return parts.join(' · ');
}

function button(text, actionId, value, style) {
  const el = {
    type: 'button',
    text: { type: 'plain_text', text: String(text).slice(0, 75) },
    action_id: actionId,
    value: String(value),
  };
  if (style) el.style = style;
  return el;
}

function overflowMenu(stepId) {
  const id = String(stepId);
  return {
    type: 'overflow',
    action_id: 'fseq_overflow',
    options: [
      { text: { type: 'plain_text', text: 'Wrong number' }, value: `wrong_number:${id}`.slice(0, 75) },
      { text: { type: 'plain_text', text: 'DQ' }, value: `dq:${id}`.slice(0, 75) },
    ],
  };
}

function viewHistoryButton(replyId) {
  if (!replyId) return null;
  return button('View full thread & history', 'view_thread', replyId);
}

/** Main call row, then overflow (Wrong number, DQ) and the history button. */
function callActionBlocks(stepId, sourceReplyId) {
  const blocks = [{
    type: 'actions',
    block_id: `fseq_call_${stepId}`.slice(0, 255),
    elements: CALL_ACTIONS.map((b) => button(b.text, b.actionId, stepId, b.style)),
  }];
  const more = [overflowMenu(stepId)];
  const view = viewHistoryButton(sourceReplyId);
  if (view) more.push(view);
  blocks.push({
    type: 'actions',
    block_id: `fseq_more_${stepId}`.slice(0, 255),
    elements: more,
  });
  return blocks;
}

function emailActionBlocks(card) {
  const replyId = card.replyId;
  const stepId = card.stepId;
  const variant = variantOf(card);
  const elements = [
    button('Send', 'approve_reply', replyId, 'primary'),
    button('Edit', 'open_edit_modal', replyId),
  ];
  if (variant === 'noshow') {
    elements.push(button('📞 Call instead', 'fseq_call_instead', stepId || replyId));
  } else {
    elements.push(button('Snooze', stepId ? 'fseq_snooze' : 'fu_snooze', stepId || replyId));
  }
  elements.push(button('Reject', 'reject_reply', replyId));
  const view = viewHistoryButton(card.sourceReplyId || replyId);
  if (view && elements.length < 5) elements.push(view);
  const blocks = [{ type: 'actions', elements }];
  if (view && elements.every((e) => e.action_id !== 'view_thread')) {
    blocks.push({ type: 'actions', elements: [view] });
  }
  return blocks;
}

function phoneBit(card) {
  const { escMrkdwn, isConfirmedMobile } = slackApi();
  const phone = clean(card.phone || (card.context && card.context.lead && card.context.lead.phone));
  if (!phone) return '';
  const mobile = isConfirmedMobile(card.enrichmentReceipt) ? ' _(mobile)_' : '';
  return `📱 ${escMrkdwn(phone)}${mobile}`;
}

function reachLine(card) {
  const { escMrkdwn, normalizeLinkedinUrl } = slackApi();
  const bits = [];
  const phone = phoneBit(card);
  if (phone) bits.push(phone);
  const email = clean(card.email || (card.context && card.context.lead && card.context.lead.email));
  if (email) bits.push(`✉️ ${escMrkdwn(email)}`);
  const li = normalizeLinkedinUrl(card.linkedinUrl || card.leadLinkedinUrl || '');
  if (li) bits.push(`🔗 <${li}|LinkedIn>`);
  return bits.join('  ·  ');
}

function whoLine(card) {
  const { escMrkdwn } = slackApi();
  const lead = (card.context && card.context.lead) || {};
  const bits = [card.leadName || lead.name, card.title || lead.title, card.company || lead.company, card.localTime]
    .map((x) => clean(x))
    .filter(Boolean)
    .map((x) => escMrkdwn(x));
  return bits.join(' · ');
}

function scoreText(card) {
  const { icpVerdictLine } = slackApi();
  const icp = card.icp || (card.context && card.context.icp) || null;
  return icpVerdictLine(icp).replace(/^\n+/, '').trim();
}

function scriptText(card) {
  const { escMrkdwn } = slackApi();
  const p = card.scriptParts;
  if (p && (p.opening || p.ifAnswer || p.ifVoicemail)) {
    const opening = escMrkdwn(clean(p.opening));
    const vm = p.ifVoicemail ? ` (VM: same line, then "${escMrkdwn(clean(p.ifVoicemail))}")` : '';
    const lines = [`*Script:* ${opening}${vm}`];
    if (p.ifAnswer) lines.push(`• Ask: ${escMrkdwn(clean(p.ifAnswer))}`);
    if (!p.ifVoicemail) lines.push('_No voicemail on this call. Just hang up if no one answers._');
    return lines.join('\n');
  }
  const lines = [];
  if (card.script) lines.push(`*Script:* ${escMrkdwn(String(card.script))}`);
  if (card.voicemail) lines.push(`(VM: ${escMrkdwn(String(card.voicemail))})`);
  else if (card.script) lines.push('_No voicemail on this call. Just hang up if no one answers._');
  return lines.join('\n');
}

function turnBlocks(label, body, { ours = false } = {}) {
  const { conversationStepBlocks, trimForCard } = slackApi();
  const text = trimForCard(body, { max: ours ? 500 : 700, ours });
  if (!text) return [];
  return conversationStepBlocks({ emoji: ours ? '🗣' : '📥', label, body: text });
}

function draftBlocks(draft) {
  const { conversationStepBlocks } = slackApi();
  if (draft == null || String(draft).trim() === '') return [];
  return conversationStepBlocks({ emoji: '✍️', label: 'Draft', body: draft });
}

function contextLine(card, state) {
  const bits = [];
  if (state && state.superseded) {
    bits.push(state.supersededPermalink
      ? `Superseded by newer card · <${state.supersededPermalink}|Open the newer card>`
      : 'Superseded by newer card');
  }
  const platform = clean(card.platform);
  const smartlead = clean(card.smartleadUrl || (card.context && card.context.links && card.context.links.smartlead));
  if (smartlead) bits.push(`<${smartlead}|Smartlead>`);
  else if (platform) bits.push(platform === 'heyreach' ? 'HeyReach' : 'Smartlead');
  if (card.permalink) bits.push(`<${card.permalink}|Original reply>`);
  if (card.replaces) bits.push(clean(card.replaces));
  else if (card.nextHint) bits.push(clean(card.nextHint));
  if (card.claimedBy) bits.push(`Caller: ${clean(card.claimedBy)}`);
  if (!bits.length) return null;
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: bits.join('  ·  ').slice(0, 2900) }],
  };
}

function closed(state) {
  return Boolean(state && (state.outcome || state.stopped || state.superseded || state.statusLine));
}

/**
 * @param {object} card
 * @param {{outcome?: string, stopped?: string, superseded?: boolean, supersededPermalink?: string, statusLine?: string, note?: string}} [state]
 * @param {{extraActionBlocks?: object[]}} [opts]
 */
function buildSequenceCard(card, state = {}, opts = {}) {
  const { escMrkdwn, loopInClientBlock, needsReviewBlock } = slackApi();
  const view = card || {};
  const variant = variantOf(view);
  const blocks = [];
  if (view.mention) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: String(view.mention) } });
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: headlineText(view).slice(0, 2900) },
  });

  const camp = clean(view.campaign || view.campaignDisplay || (view.context && view.context.campaign));
  const who = whoLine(view);
  const reach = reachLine(view);
  const facts = [
    camp ? `📣 ${escMrkdwn(camp)}` : '',
    who,
    reach,
  ].filter(Boolean);
  if (facts.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: facts.join('\n').slice(0, 2900) } });
  }
  const scores = scoreText(view);
  if (scores) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: scores.slice(0, 2900) } });
  blocks.push({ type: 'divider' });

  if (variant === 'call') {
    const script = scriptText(view);
    if (script) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: script.slice(0, 2900) } });
  } else {
    const ourDow = view.ourAt ? weekdayOf(view.ourAt, view.tz) : '';
    const theirDow = view.theirAt ? weekdayOf(view.theirAt, view.tz) : '';
    const ourLabel = ourDow ? `We said (${ourDow})` : 'We said';
    const theirLabel = theirDow ? `They said (${theirDow})` : 'They said';
    if (variant !== 'noshow') {
      blocks.push(...turnBlocks(ourLabel, view.ourText || (view.context && view.context.lastSent), { ours: true }));
      const theirs = view.theirText || (view.context && view.context.reply);
      if (theirs && !/^\(no new reply/i.test(clean(theirs))) {
        blocks.push(...turnBlocks(theirLabel, theirs, { ours: false }));
      }
    }
    blocks.push(...draftBlocks(view.draft));
  }

  const loop = view.needsClient ? loopInClientBlock(view.needsClient, view.whatToSend) : null;
  if (loop) blocks.push(loop);
  if (view.review && needsReviewBlock) blocks.push(needsReviewBlock());

  const done = closed(state);
  if (done) {
    const line = state.statusLine
      || (state.superseded ? 'Superseded by newer card' : '')
      || (state.stopped ? `Sequence stopped (${String(state.stopped).replace(/_/g, ' ')})` : '')
      || (state.outcome ? String(state.outcome).replace(/_/g, ' ') : '');
    if (line) {
      const whoClicked = state.outcomeBy ? ` · <@${state.outcomeBy}>` : '';
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${escMrkdwn(line)}${whoClicked}`.slice(0, 2900) }],
      });
    }
    if (state.note) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: String(state.note).slice(0, 2900) } });
    }
    const viewBtn = viewHistoryButton(view.sourceReplyId || view.replyId);
    if (viewBtn) blocks.push({ type: 'actions', elements: [viewBtn] });
  } else if (variant === 'call') {
    blocks.push(...callActionBlocks(view.stepId, view.sourceReplyId || view.replyId));
  } else if (!view.hideSend) {
    blocks.push(...emailActionBlocks(view));
  }
  for (const extra of opts.extraActionBlocks || []) {
    if (extra) blocks.push(extra);
  }
  const foot = contextLine(view, state);
  if (foot) blocks.push(foot);
  if (blocks.length > 50) blocks.length = 50;
  return blocks;
}

const SNOOZE_MODAL_ID = 'fseq_snooze_modal';

function ymdInZone(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function buildSnoozeModal({ stepId, replyId, channel, ts, tz, now = new Date() } = {}) {
  const zone = tz || 'America/Chicago';
  const tomorrow = addDaysYmd(ymdInZone(now, zone), 1);
  return {
    type: 'modal',
    callback_id: SNOOZE_MODAL_ID,
    private_metadata: JSON.stringify({
      stepId: stepId || null,
      replyId: replyId || null,
      channel: channel || null,
      ts: ts || null,
      tz: zone,
    }),
    title: { type: 'plain_text', text: 'Snooze' },
    submit: { type: 'plain_text', text: 'Snooze' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `The card comes back on the morning you pick (${zone}). Nothing sends until then.`,
        },
      },
      {
        type: 'input',
        block_id: 'snooze_block',
        label: { type: 'plain_text', text: 'Bring this card back on' },
        element: {
          type: 'datepicker',
          action_id: 'snooze_date',
          initial_date: tomorrow,
        },
      },
    ],
  };
}

function snoozeDateError(ymd, tz, now = new Date()) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return 'Pick a date.';
  const today = ymdInZone(now, tz || 'America/Chicago');
  if (ymd < today) return 'That date has already passed. Pick today or a later day.';
  const cap = addDaysYmd(today, 21);
  if (ymd > cap) return 'Pick a day in the next three weeks.';
  return null;
}

function validateSnoozeSubmission(interaction, { now = new Date() } = {}) {
  let meta = {};
  try { meta = JSON.parse(interaction.view?.private_metadata || '{}'); } catch { meta = {}; }
  const ymd = interaction.view?.state?.values?.snooze_block?.snooze_date?.selected_date;
  const err = snoozeDateError(ymd, meta.tz, now);
  return err ? { snooze_block: err } : null;
}

function historySectionBlocks(lines) {
  const blocks = [
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Lead history*' } },
  ];
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!list.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No earlier cards, calls, or button clicks are stored for this lead yet._' },
    });
    return blocks;
  }
  const text = list.map((line) => `• ${line}`).join('\n');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } });
  return blocks;
}

module.exports = {
  DAY_OF_FIVE,
  CALL_ACTIONS,
  SNOOZE_MODAL_ID,
  variantOf,
  headlineText,
  whyLine,
  dayPhrase,
  buildSequenceCard,
  callActionBlocks,
  emailActionBlocks,
  buildSnoozeModal,
  snoozeDateError,
  validateSnoozeSubmission,
  historySectionBlocks,
  ymdInZone,
  weekdayOf,
};
