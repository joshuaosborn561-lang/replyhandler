'use strict';

/**
 * Manual ghosted-meeting leads: people who booked through Allo calls or Calendly and so have no
 * SmartLead or HeyReach reply. POST /admin/ghosted-meetings/enroll with manual:true creates one
 * inert context row in pending_replies (campaign_id 'manual-ghost') for the ghost sequence to hang off.
 * Its approval cards carry the same marker, and reply-send.js sends those as a NEW email from the
 * connected SalesGlider Gmail mailbox, only after a human approves the card.
 */

const MANUAL_CAMPAIGN_ID = 'manual-ghost';

function isManualGhostReply(reply) {
  return Boolean(reply) && String(reply.campaign_id || '') === MANUAL_CAMPAIGN_ID;
}

/**
 * The one-off Gmail send is the SalesGlider mailbox, so only SalesGlider's own client row (or a client
 * id listed in MANUAL_GHOST_SEND_CLIENT_IDS) may use it. Any other client fails closed before a card exists.
 */
function clientMayManualSend(client, env = process.env) {
  if (!client) return false;
  if (/^\s*sales\s*glider/i.test(String(client.name || ''))) return true;
  const ids = String(env.MANUAL_GHOST_SEND_CLIENT_IDS || '').split(/[,\s]+/).filter(Boolean);
  return ids.includes(String(client.id));
}

const DEFAULT_SUBJECT = 'Rescheduling our call';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlFromText(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

module.exports = { MANUAL_CAMPAIGN_ID, isManualGhostReply, clientMayManualSend, DEFAULT_SUBJECT, htmlFromText };
