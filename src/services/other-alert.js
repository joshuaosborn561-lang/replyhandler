/**
 * Retired Oct 27 2026 (Josh: "if it's not a legit interested or question I
 * don't wanna see junk"). OTHER / unclassified replies used to get a compact
 * "Unclassified reply" line in the client's channel. They are now recorded as
 * suppressed rows only (reason `not_interested_channel`) and never posted.
 * `postOtherAlert` stays for manual use; nothing calls it on the live paths.
 */

const db = require('../db');
const { cleanInboundOrRaw } = require('../utils/smartlead-webhook-helpers');

const OTHER_ALERT_REASON = 'not_interested_channel';

// eslint-disable-next-line no-unused-vars
function shouldAlertOther(reason, classification) {
  return false;
}

function compactOtherAlertText({ leadName, platform, inboundMessage, leadPhone } = {}) {
  const snippet = cleanInboundOrRaw(inboundMessage).replace(/\s+/g, ' ').trim();
  if (!snippet) return null;
  const short = snippet.length > 280 ? `${snippet.slice(0, 277)}…` : snippet;
  const who = String(leadName || 'Unknown').trim();
  const where = platform === 'heyreach' ? 'LinkedIn' : 'Email';
  const phone = String(leadPhone || '').trim();
  return `💬 Unclassified reply · ${who} (${where})${phone ? ` · 📱 ${phone}` : ''}\n> ${short}\n_Not auto-drafted. Reply manually if it needs one._`;
}

async function postOtherAlert({
  clientId, client: clientRow, platform, leadName, inboundMessage, leadPhone,
}, deps = {}) {
  const text = compactOtherAlertText({ leadName, platform, inboundMessage, leadPhone });
  if (!text) {
    console.log('[OtherAlert] Skipped empty inbound', { clientId, platform, reason: 'empty_inbound' });
    return null;
  }
  try {
    let client = clientRow;
    if (!client) {
      const { rows } = await (deps.db || db).query(
        'SELECT slack_bot_token, slack_channel_id, active FROM clients WHERE id = $1', [clientId],
      );
      client = rows[0];
    }
    if (!client || client.active === false || !client.slack_bot_token || !client.slack_channel_id) return null;
    const { WebClient } = deps.WebClient ? { WebClient: deps.WebClient } : require('@slack/web-api');
    const slack = new WebClient(client.slack_bot_token);
    const res = await slack.chat.postMessage({
      channel: client.slack_channel_id,
      text,
      unfurl_links: false,
    });
    console.log('[OtherAlert] Posted', { clientId, platform });
    return res;
  } catch (err) {
    console.warn('[OtherAlert] Post failed', { clientId, err: err.message });
    return null;
  }
}

module.exports = { OTHER_ALERT_REASON, shouldAlertOther, compactOtherAlertText, postOtherAlert };
