/**
 * Speed to lead: ping the caller (Cayden) in the card's Slack thread the
 * moment a positive reply is carded, so a call happens inside 5 minutes.
 *
 * Off unless SPEED_TO_LEAD_MENTION is set (e.g. "<@U0123ABC>"). Posts at most
 * twice per reply: once when the card posts, and once more when a phone number
 * lands later from enrichment (only if the first ping had no phone).
 * Nothing is sent to the prospect.
 */
const POSITIVE = new Set(['INTERESTED', 'MEETING_PROPOSED']);
const pinged = new Map(); // replyId -> { withPhone }

function mention(env = process.env) {
  return String(env.SPEED_TO_LEAD_MENTION || '').trim();
}

function isPositive(classification) {
  return POSITIVE.has(String(classification || '').toUpperCase());
}

function pingText({ who, leadName, phone, late = false }) {
  const name = String(leadName || 'this lead').trim() || 'this lead';
  if (phone) {
    return late
      ? `${who} 📞 Phone found for ${name}: ${phone}. Call now.`
      : `${who} 📞 Positive reply from ${name}. Call now: ${phone}`;
  }
  return `${who} 📞 Positive reply from ${name}. No phone yet, I'll ping again if enrichment finds one.`;
}

/**
 * @returns {Promise<boolean>} true when a ping was posted.
 */
async function pingCaller({
  slackApi, token, channelId, threadTs, replyId, classification, leadName, phone, late = false,
}, env = process.env) {
  const who = mention(env);
  if (!who || !token || !channelId || !threadTs || !replyId) return false;
  if (!isPositive(classification)) return false;
  const key = String(replyId);
  const prior = pinged.get(key);
  if (late) {
    if (!phone || !prior || prior.withPhone) return false;
  } else if (prior) {
    return false;
  }
  pinged.set(key, { withPhone: Boolean(phone) || Boolean(prior && prior.withPhone) });
  try {
    await slackApi.postClientActionNotice(token, channelId, pingText({ who, leadName, phone, late }), threadTs);
    return true;
  } catch (err) {
    console.warn('[SpeedToLead] Ping failed', { replyId, err: err.message });
    return false;
  }
}

function _resetForTests() { pinged.clear(); }

module.exports = { pingCaller, pingText, isPositive, _resetForTests };
