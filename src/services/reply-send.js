const db = require('../db');
const smartlead = require('./smartlead');
const heyreach = require('./heyreach');
const calendar = require('./calendar');
const { parseProposedTime } = require('../utils/parse-proposed-time');

/** Rows created by POST /admin/test/slack-draft — not real SmartLead/HeyReach leads */
function isSlackTestFixtureReply(reply) {
  return reply.campaign_id === 'test-campaign' && reply.lead_id === 'test-lead';
}

async function sendReplyToPlatform(client, reply, replyText) {
  if (isSlackTestFixtureReply(reply)) {
    console.log('[ReplySend] Skipping outbound API — Slack test fixture', { replyId: reply.id, platform: reply.platform });
    return;
  }
  if (reply.platform === 'smartlead') {
    await smartlead.sendReply(client.smartlead_api_key, reply.campaign_id, reply.lead_id, replyText);
  } else if (reply.platform === 'heyreach') {
    const ctx = typeof reply.thread_context === 'string' ? JSON.parse(reply.thread_context) : reply.thread_context;
    const meta = ctx?.heyreach || {};
    await heyreach.sendMessage(client.heyreach_api_key, {
      conversationId: meta.conversationId || null,
      linkedInAccountId: meta.linkedinAccountId || null,
      listId: meta.listId || null,
      linkedinUrl: meta.linkedinUrl || reply.linkedin_url || null,
      message: replyText,
    });
  } else {
    throw new Error(`Unknown platform: ${reply.platform}`);
  }
}

/**
 * After a human-approved message is sent, optionally book calendar for MEETING_PROPOSED.
 * Returns a status line suffix (empty string if none).
 */
async function maybeBookMeetingAfterSend(reply, client) {
  if (isSlackTestFixtureReply(reply)) return '';
  if (reply.classification !== 'MEETING_PROPOSED') return '';

  const { rows: [meeting] } = await db.query('SELECT * FROM meetings WHERE pending_reply_id = $1', [reply.id]);
  if (!meeting || !meeting.proposed_time) return '';

  const attendeeEmail = reply.lead_email || meeting.lead_email;
  if (!attendeeEmail) {
    return '\n⚠️ No email for this prospect — calendar invite not sent. Book manually.';
  }

  try {
    const result = await calendar.bookMeeting(reply.client_id, {
      summary: `Call with ${reply.lead_name}`,
      description: `Booked via SalesGlider AI Reply Handler (${reply.platform})`,
      startTime: parseProposedTime(meeting.proposed_time),
      durationMinutes: 30,
      attendeeEmail,
      attendeeName: reply.lead_name || 'Prospect',
    });

    await db.query(
      `UPDATE meetings SET status = 'booked', confirmed_time = $1, calendar_event_id = $2,
       calendar_provider = $3, meeting_link = $4, updated_at = now() WHERE id = $5`,
      [parseProposedTime(meeting.proposed_time), result.eventId, result.provider, result.meetingLink, meeting.id]
    );

    const linkMsg = result.meetingLink ? ` Meeting link: ${result.meetingLink}` : '';
    console.log('[ReplySend] Meeting booked', { meetingId: meeting.id, provider: result.provider, eventId: result.eventId });
    return `\n📅 Meeting booked on ${result.provider} calendar.${linkMsg}`;
  } catch (bookErr) {
    console.error('[ReplySend] Calendar booking failed (reply still sent)', { err: bookErr.message });
    return `\n⚠️ Calendar booking failed: ${bookErr.message}. Please book manually.`;
  }
}

module.exports = { sendReplyToPlatform, maybeBookMeetingAfterSend, isSlackTestFixtureReply };
