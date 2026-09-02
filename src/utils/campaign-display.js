/**
 * Human-readable campaign label for Slack cards.
 * Prefer the campaign name; keep the id in parentheses when both are known.
 */

function formatCampaignDisplay(campaignName, campaignId) {
  const id = campaignId != null ? String(campaignId).trim() : '';
  const name = campaignName != null ? String(campaignName).trim() : '';
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  if (id) return `Campaign ${id}`;
  return '';
}

/**
 * Pull a stored / nested campaign name off a pending_replies row.
 */
function campaignNameFromReply(reply) {
  if (!reply) return null;
  if (reply.campaign_name && String(reply.campaign_name).trim()) {
    return String(reply.campaign_name).trim();
  }
  let tc = reply.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (tc && typeof tc === 'object') {
    const fromHr = tc.heyreach?.campaignName || tc.heyreach?.campaign_name;
    if (fromHr && String(fromHr).trim()) return String(fromHr).trim();
    if (tc.campaign_name && String(tc.campaign_name).trim()) {
      return String(tc.campaign_name).trim();
    }
    if (tc.email_campaign_name && String(tc.email_campaign_name).trim()) {
      return String(tc.email_campaign_name).trim();
    }
  }
  return null;
}

module.exports = {
  formatCampaignDisplay,
  campaignNameFromReply,
};
