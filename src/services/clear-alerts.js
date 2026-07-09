const db = require('../db');
const slack = require('./slack');

const OPEN_STATUSES = ['pending', 'flagged', 'alert_only', 'approved'];

async function loadActiveClients(clientId) {
  if (clientId) {
    const { rows } = await db.query(
      `SELECT * FROM clients WHERE id = $1 AND active IS DISTINCT FROM false`,
      [clientId]
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT * FROM clients WHERE active IS DISTINCT FROM false ORDER BY name`
  );
  return rows;
}

async function openRepliesForClient(clientId) {
  const { rows } = await db.query(
    `SELECT id, slack_message_ts, lead_name, status, platform, classification
       FROM pending_replies
      WHERE client_id = $1
        AND status = ANY($2::text[])
      ORDER BY created_at ASC`,
    [clientId, OPEN_STATUSES]
  );
  return rows;
}

async function clearSlackCard(token, channelId, messageTs, leadName, note) {
  if (!messageTs || !token || !channelId) return { skipped: true };
  const text = note || `✅ Cleared — marked as actioned. *${leadName || 'prospect'}*`;
  try {
    await slack.updateMessage(token, channelId, messageTs, text);
    return { updated: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Mark all open alerts as sent and strip action buttons from Slack cards.
 */
async function clearAllAlerts({ clientId, dryRun = false, note } = {}) {
  const clients = await loadActiveClients(clientId);
  const summary = {
    clients: clients.length,
    repliesMarkedSent: 0,
    slackUpdated: 0,
    slackErrors: 0,
    followUpsCancelled: 0,
    byClient: [],
  };

  for (const client of clients) {
    const clientResult = {
      clientId: client.id,
      clientName: client.name,
      channelId: client.slack_channel_id,
      repliesMarkedSent: 0,
      slackUpdated: 0,
      slackErrors: 0,
      followUpsCancelled: 0,
    };

    const open = await openRepliesForClient(client.id);

    for (const row of open) {
      if (!dryRun) {
        await db.query(
          `UPDATE pending_replies
              SET status = 'sent',
                  sent_reply = COALESCE(NULLIF(btrim(sent_reply), ''), draft_reply),
                  updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
      }
      clientResult.repliesMarkedSent++;
      summary.repliesMarkedSent++;

      if (row.slack_message_ts) {
        const slackResult = dryRun
          ? { updated: true }
          : await clearSlackCard(
            client.slack_bot_token,
            client.slack_channel_id,
            row.slack_message_ts,
            row.lead_name,
            note
          );
        if (slackResult.updated) {
          clientResult.slackUpdated++;
          summary.slackUpdated++;
        } else if (slackResult.error) {
          clientResult.slackErrors++;
          summary.slackErrors++;
        }
      }
    }

    if (!dryRun) {
      const { rowCount } = await db.query(
        `UPDATE outbound_follow_ups
            SET status = 'cancelled', updated_at = now()
          WHERE client_id = $1
            AND status = 'pending'`,
        [client.id]
      );
      clientResult.followUpsCancelled = rowCount || 0;
      summary.followUpsCancelled += clientResult.followUpsCancelled;
    }

    summary.byClient.push(clientResult);
  }

  return summary;
}

module.exports = {
  clearAllAlerts,
  clearSlackCard,
  OPEN_STATUSES,
};
