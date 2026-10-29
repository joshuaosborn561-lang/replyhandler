'use strict';

/**
 * Context block for every card in #followups-ai-replies (call cards, follow-up
 * email cards, rebook / no-show cards). Pure, no I/O: the caller loads the
 * stored rows and passes them in. Nothing here calls a model; the ICP and
 * decision-maker lines come from the verdicts already stored on the original
 * reply row (pending_replies.icp_verdict).
 *
 * Top of card:
 *   *Client*
 *   lead name · title · company
 *   phone · email
 *   campaign / offer / meeting or no-show time
 *   their reply (quoted, short) and our last send (short)
 *   links: original reply card, Smartlead thread
 *   ICP fit + decision maker, same wording as reply cards
 */

const REPLY_EXCERPT_MAX = 300;
const SENT_EXCERPT_MAX = 160;
const FULL_TEXT_MAX = 6000;
const OFFER_MAX = 200;

function clean(s) {
  return String(s == null ? '' : s).replace(/\r/g, '').trim();
}

function oneLine(s) {
  return clean(s).replace(/\s+/g, ' ');
}

function excerpt(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The offer for a card. Config first, copy last:
 *   1. a hand-entered offer row (followup_sequence_copy, source 'manual')
 *   2. the client's stored ICP offer (clients.icp_profile.offer)
 *   3. the offer extracted from the campaign copy
 * Returns '' when none exists anywhere, and the line is then left out.
 */
function pickOffer({ manualOffer, icpProfile, copyOffer } = {}) {
  const tidy = (v) => oneLine(v).replace(/[.!\s]+$/, '').slice(0, OFFER_MAX);
  const manual = tidy(manualOffer);
  if (manual) return { text: manual, source: 'manual' };
  let profile = icpProfile;
  if (typeof profile === 'string') {
    try { profile = JSON.parse(profile); } catch { profile = null; }
  }
  const raw = profile && typeof profile === 'object' ? profile.offer : null;
  const fromIcp = tidy(Array.isArray(raw) ? raw.find((x) => clean(x)) : raw);
  if (fromIcp) return { text: fromIcp, source: 'client_icp' };
  const copy = tidy(copyOffer);
  if (copy) return { text: copy, source: 'campaign_copy' };
  return { text: '', source: 'none' };
}

/** Link to the lead's Smartlead conversation. Master inbox deep link needs the campaign-lead map id. */
function smartleadThreadUrl({ campaignId, mapId } = {}) {
  const map = mapId != null && /^\d+$/.test(String(mapId).trim()) ? String(mapId).trim() : '';
  if (map) return `https://app.smartlead.ai/app/master-inbox?campaign_lead_map_id=${map}`;
  const cid = campaignId != null && /^\d+$/.test(String(campaignId).trim()) ? String(campaignId).trim() : '';
  return cid ? `https://app.smartlead.ai/app/email-campaign/${cid}/analytics` : null;
}

function formatMeetingTime(date, tz = 'America/Chicago') {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(d);
  } catch {
    return '';
  }
}

function parseIcp(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  return v && typeof v === 'object' ? v : null;
}

/** Company is not stored on older rows: fall back to the work-email / website domain. */
function companyFor({ company, email, website } = {}) {
  const c = oneLine(company);
  if (c) return c;
  const free = /^(gmail|yahoo|hotmail|outlook|icloud|aol|proton(mail)?|live|msn|me)\./i;
  const fromHost = (h) => {
    const host = clean(h).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return host && host.includes('.') && !free.test(host) ? host : '';
  };
  const w = fromHost(website);
  if (w) return w;
  const at = clean(email).toLowerCase().split('@')[1] || '';
  return fromHost(at);
}

/**
 * @param {object} i
 * @param {string} i.clientName
 * @param {{name,title,company,phone,email,website}} i.lead
 * @param {string} i.replyText     their actual reply (full)
 * @param {string} i.lastSentText  our last sent message (full)
 * @param {string} i.campaign      display name
 * @param {string} i.offer
 * @param {{label:string, text:string}|null} i.meeting
 * @param {{replyCard?:string, smartlead?:string}} i.links
 * @param {object|null} i.icp      stored pending_replies.icp_verdict (incl. decision_maker)
 */
function buildFollowupContext(i = {}) {
  const lead = i.lead || {};
  const reply = clean(i.replyText).slice(0, FULL_TEXT_MAX);
  const sent = clean(i.lastSentText).slice(0, FULL_TEXT_MAX);
  const meeting = i.meeting && i.meeting.text ? { label: clean(i.meeting.label) || 'Meeting', text: clean(i.meeting.text) } : null;
  return {
    clientName: oneLine(i.clientName) || 'Client',
    lead: {
      name: oneLine(lead.name),
      title: oneLine(lead.title),
      company: companyFor({ company: lead.company, email: lead.email, website: lead.website }),
      phone: oneLine(lead.phone),
      email: oneLine(lead.email),
    },
    reply,
    replyExcerpt: excerpt(reply, REPLY_EXCERPT_MAX),
    lastSent: sent,
    lastSentExcerpt: excerpt(sent, SENT_EXCERPT_MAX),
    campaign: oneLine(i.campaign),
    offer: oneLine(i.offer).slice(0, OFFER_MAX),
    meeting,
    links: {
      replyCard: clean(i.links && i.links.replyCard) || null,
      smartlead: clean(i.links && i.links.smartlead) || null,
    },
    icp: parseIcp(i.icp),
  };
}

function slackApi() {
  // Lazy: slack.js is large and requires many modules.
  return require('../services/slack');
}

function quoteLine(emoji, label, text) {
  const { escMrkdwn } = slackApi();
  return `${emoji} *${label}:*\n>${escMrkdwn(text).replace(/\n/g, '\n>')}`;
}

/** ICP fit + decision maker, wording identical to reply cards. Stored verdicts only. */
function icpDmText(icp) {
  const { icpVerdictLine, escMrkdwn } = slackApi();
  if (!icp || (!icp.status && !icp.decision_maker && !icp.decisionMaker)) {
    return `🎯 ICP: not graded on the original card\n👤 ${escMrkdwn('Decision maker: unknown (title not found)')}`;
  }
  return icpVerdictLine(icp).replace(/^\n/, '');
}

/** Top-of-card blocks. Two sections: who/what, then the ICP + decision-maker verdicts. */
function followupContextBlocks(ctx) {
  if (!ctx) return [];
  const { escMrkdwn } = slackApi();
  const lines = [`*${escMrkdwn(ctx.clientName)}*`];

  const who = [`*${escMrkdwn(ctx.lead.name || 'Unknown lead')}*`];
  if (ctx.lead.title) who.push(escMrkdwn(ctx.lead.title));
  if (ctx.lead.company) who.push(escMrkdwn(ctx.lead.company));
  lines.push(`👤 ${who.join(' · ')}`);
  const reach = [];
  reach.push(ctx.lead.phone ? `📞 ${escMrkdwn(ctx.lead.phone)}` : '📞 no phone');
  if (ctx.lead.email) reach.push(`✉️ ${escMrkdwn(ctx.lead.email)}`);
  lines.push(reach.join(' · '));

  if (ctx.campaign) lines.push(`📣 *Campaign:* ${escMrkdwn(ctx.campaign)}`);
  if (ctx.offer) lines.push(`🎁 *Offer:* ${escMrkdwn(ctx.offer)}`);
  if (ctx.meeting) lines.push(`🗓️ *${escMrkdwn(ctx.meeting.label)}:* ${escMrkdwn(ctx.meeting.text)}`);
  if (ctx.replyExcerpt) lines.push(quoteLine('💬', 'They replied', ctx.replyExcerpt));
  if (ctx.lastSentExcerpt) lines.push(quoteLine('📤', 'We last sent', ctx.lastSentExcerpt));

  const links = [];
  if (ctx.links.replyCard) links.push(`<${ctx.links.replyCard}|Original reply card>`);
  if (ctx.links.smartlead) links.push(`<${ctx.links.smartlead}|Smartlead thread>`);
  if (links.length) lines.push(`🔗 ${links.join(' · ')}`);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2990) } },
    { type: 'section', text: { type: 'mrkdwn', text: icpDmText(ctx.icp).slice(0, 2990) } },
  ];
}

/**
 * Full texts, for directly under the call script: the full email we sent, then
 * their full reply, both quoted in full. The top block keeps short excerpts.
 */
function followupFullTextBlocks(ctx) {
  if (!ctx) return [];
  const { conversationStepBlocks } = slackApi();
  const blocks = [];
  if (ctx.lastSent) {
    blocks.push(...conversationStepBlocks({ emoji: '📤', label: 'Full email we sent', body: ctx.lastSent }));
  }
  if (ctx.reply) {
    blocks.push(...conversationStepBlocks({ emoji: '💬', label: 'Their full reply', body: ctx.reply }));
  }
  return blocks;
}

module.exports = {
  REPLY_EXCERPT_MAX,
  SENT_EXCERPT_MAX,
  excerpt,
  pickOffer,
  smartleadThreadUrl,
  formatMeetingTime,
  companyFor,
  buildFollowupContext,
  followupContextBlocks,
  followupFullTextBlocks,
  icpDmText,
};
