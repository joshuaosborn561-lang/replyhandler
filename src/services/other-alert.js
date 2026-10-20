/**
 * OTHER replies are no longer hidden silently. They get one compact line in
 * the client's Slack channel so a classifier miss is still visible.
 */

const db = require('../db');

const OTHER_ALERT_REASON = 'not_interested_channel';

function shouldAlertOther(reason, classification) {
  return reason === OTHER_ALERT_REASON
    && String(classification || 'OTHER').toUpperCase() !== 'FOLLOW_UP';
}

function compactOtherAlertText({ leadName, platform, inboundMessage, leadPhone } = {}) {
  const snippet = String(inboundMessage || '').replace(/\s+/g, ' ').trim();
  const short = snippet.length > 280 ? `${snippet.slice(0, 277)}…` : snippet;
  const who = String(leadName || 'Unknown').trim();
  const where = platform === 'heyreach' ? 'LinkedIn' : 'Email';
  const phone = String(leadPhone || '').trim();
  return `💬 Unclassified reply · ${who} (${where})${phone ? ` · 📱 ${phone}` : ''}\n> ${short || '(no text)'}\n_Not auto-drafted. Reply manually if it needs one._`;
}

async function postOtherAlert({
  clientId, client: clientRow, platform, leadName, inboundMessage, leadPhone,
}, deps = {}) {
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
      text: compactOtherAlertText({ leadName, platform, inboundMessage, leadPhone }),
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
