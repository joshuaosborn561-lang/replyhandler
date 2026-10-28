'use strict';

/**
 * Loads the stored facts for a #followups-ai-replies card and hands them to the
 * pure builder (src/utils/followup-card-context.js). No model calls: the ICP and
 * decision-maker verdicts are read off the original reply row.
 *
 * Field sources
 *   client name      clients.name
 *   lead name        pending_replies.lead_full_name, else lead_name
 *   title            pending_replies.lead_title, else icp_verdict.decision_maker.title
 *   company          pending_replies.lead_company, else lead_website / work-email domain
 *   phone            phoneForFollowUp() (the phone the call card dials)
 *   email            pending_replies.lead_email
 *   their reply      pending_replies.inbound_message of the original reply row
 *   our last send    pending_replies.sent_reply, else last "us" turn in thread_context
 *   campaign         pending_replies.campaign_name / campaign_id
 *   offer            manual followup_sequence_copy row, else clients.icp_profile.offer,
 *                    else the offer extracted from campaign copy; omitted when none
 *   meeting / no-show time   followup_sequence_steps.payload.ghost.meetingStart
 *   reply card link  Slack permalink of the original card (pending_replies.slack_message_ts)
 *   Smartlead link   campaign_lead_map_id from Smartlead's lead lookup, else the campaign page
 *   ICP + DM         pending_replies.icp_verdict (stored on the original card)
 */

const ctxUtil = require('../utils/followup-card-context');
const { extractThreadMessages } = require('../utils/thread-transcript');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function isPlaceholder(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s || s.startsWith('(no new reply') || s.includes('follow-up re-attempt');
}

function lastSentFrom(source) {
  const sent = String(source.sent_reply || '').trim();
  if (sent) return sent;
  try {
    const msgs = extractThreadMessages(source.platform, source.thread_context, { maxMessages: 40 });
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'us' && msgs[i].body) return msgs[i].body;
    }
  } catch { /* thread is optional */ }
  return '';
}

function titleFrom(source) {
  const direct = String(source.lead_title || '').trim();
  if (direct) return direct;
  const icp = parseJson(source.icp_verdict);
  const dm = icp && (icp.decision_maker || icp.decisionMaker);
  return dm && dm.title ? String(dm.title).trim() : '';
}

/** Best effort: Smartlead's campaign-lead map id for the master inbox deep link. */
async function smartleadMapId(client, source, { smartlead } = {}) {
  if (source.platform !== 'smartlead' || !client.smartlead_api_key || !source.lead_email) return null;
  try {
    const sl = smartlead || require('./smartlead');
    const found = await sl.lookupLeadByEmail(client.smartlead_api_key, source.lead_email);
    const rows = found && found.lead && Array.isArray(found.lead.lead_campaign_data) ? found.lead.lead_campaign_data : [];
    const row = rows.find((r) => String(r.campaign_id || r.campaignId || '') === String(source.campaign_id || ''));
    const id = row && (row.campaign_lead_map_id || row.email_lead_map_id || row.campaignLeadMapId);
    return id != null ? String(id) : null;
  } catch (err) {
    console.warn('[FollowupCtx] smartlead map id lookup skipped', { err: err.message });
    return null;
  }
}

/**
 * @param {object} a
 * @param {object} a.client      clients row
 * @param {object} a.source      the original pending_replies row
 * @param {string} [a.phone]
 * @param {string} [a.offer]     already resolved offer text
 * @param {string|null} [a.permalink]
 * @param {object|null} [a.ghost]  step payload.ghost ({ meetingStart, reason })
 */
async function loadFollowupContext({ client, source, phone = '', offer = '', permalink = null, ghost = null, env = process.env, deps = {} }) {
  const mapId = await smartleadMapId(client, source, deps);
  const tz = String(client.digest_timezone || source.lead_timezone || 'America/Chicago');
  const meeting = ghost && ghost.meetingStart
    ? { label: 'No-show', text: ctxUtil.formatMeetingTime(ghost.meetingStart, tz) }
    : null;
  const replyText = isPlaceholder(source.inbound_message) ? '' : String(source.inbound_message || '');
  return ctxUtil.buildFollowupContext({
    clientName: client.name,
    lead: {
      name: source.lead_full_name || source.lead_name,
      title: titleFrom(source),
      company: source.lead_company,
      phone,
      email: source.lead_email,
      website: source.lead_website,
    },
    replyText: require('./slack').plainTextForSlack
      ? require('./slack').plainTextForSlack(replyText)
      : replyText,
    lastSentText: lastSentFrom(source),
    campaign: formatCampaignDisplay(campaignNameFromReply(source), source.campaign_id),
    offer,
    meeting,
    links: {
      replyCard: permalink,
      smartlead: ctxUtil.smartleadThreadUrl({ campaignId: source.campaign_id, mapId }),
    },
    icp: source.icp_verdict,
  });
}

module.exports = { loadFollowupContext, lastSentFrom, titleFrom, isPlaceholder };
