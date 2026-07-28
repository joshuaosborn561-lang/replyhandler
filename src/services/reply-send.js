const db = require('../db');
const smartlead = require('./smartlead');
const heyreach = require('./heyreach');
const calendar = require('./calendar');
const { parseProposedTime } = require('../utils/parse-proposed-time');
const { buildSmartleadCcList, alwaysCcEmails, roundRobinEmails } = require('./client-cc');
const { enrichProspect } = require('./prospect-enrich');
const { buildClientNotifyEmail } = require('./client-notify-email');
const gmail = require('./gmail-send');

async function sendReplyToPlatform(client, reply, replyText) {
  if (reply.platform === 'smartlead') {
    await smartlead.sendReply(client.smartlead_api_key, reply.campaign_id, reply.lead_id, replyText);

    // Deliverability: the prospect gets a normal reply with no CC.
    // Notify Always-forward + round-robin recipients from primary Gmail with
    // thread history + enrichment (LinkedIn/website/email/cell).
    const hasForwardConfig = alwaysCcEmails(client).length > 0 || roundRobinEmails(client).length > 0;
    if (!hasForwardConfig) return {};

    const ccMeta = await buildSmartleadCcList(client, { claimRoundRobin: true });
    const forwardEmails = ccMeta.ccEmails;
    if (!forwardEmails) return {};

    let enrichment = null;
    try {
      enrichment = await enrichProspect({
        email: reply.lead_email,
        linkedinUrl: reply.linkedin_url,
        leadName: reply.lead_name,
      });
    } catch (err) {
      console.warn('[ReplySend] Prospect enrichment failed (notifying without full enrich)', {
        replyId: reply.id, err: err.message,
      });
      enrichment = {
        email: reply.lead_email || null,
        phone: null,
        linkedinUrl: reply.linkedin_url || null,
        website: null,
        sources: {},
      };
    }

    const notify = buildClientNotifyEmail({
      leadName: reply.lead_name,
      clientName: client.name,
      campaignName: reply.campaign_id,
      enrichment,
      threadContext: reply.thread_context,
      inboundMessage: reply.inbound_message,
      sentText: replyText,
    });

    let notifyStatusLine = '';
    try {
      if (!gmail.isConfigured()) {
        throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured');
      }
      const account = await gmail.getAccount();
      if (!account) {
        throw new Error('Primary Gmail not connected — open /auth/gmail/connect');
      }

      await gmail.sendMail({
        to: forwardEmails,
        subject: notify.subject,
        htmlBody: notify.htmlBody,
        textBody: notify.textBody,
      });
      console.log('[ReplySend] Client notify sent from primary Gmail', {
        replyId: reply.id,
        to: forwardEmails,
        from: account.email,
        always: ccMeta.always,
        roundRobin: ccMeta.roundRobin,
        cellPhone: enrichment?.phone || null,
        linkedin: enrichment?.linkedinUrl || null,
        sources: enrichment?.sources || null,
      });
      notifyStatusLine = `\n📧 Client copy notified to ${forwardEmails} (Gmail)`;
    } catch (mailErr) {
      console.warn('[ReplySend] Primary Gmail notify failed — falling back to SmartLead forward', {
        replyId: reply.id, err: mailErr.message,
      });
      try {
        await smartlead.forwardThreadToClient(
          client.smartlead_api_key,
          reply.campaign_id,
          reply.lead_id,
          {
            toEmail: forwardEmails,
            leadName: reply.lead_name,
            leadEmail: enrichment?.email || reply.lead_email,
            sentText: replyText,
            cellPhone: enrichment?.phone || null,
            phoneProvider: enrichment?.sources?.phone || null,
          }
        );
        notifyStatusLine = `\n📧 Client copy forwarded to ${forwardEmails} (SmartLead — Gmail notify failed: ${mailErr.message})`;
      } catch (fwdErr) {
        console.error('[ReplySend] Client copy failed (reply still sent)', {
          replyId: reply.id, gmailErr: mailErr.message, fwdErr: fwdErr.message,
        });
        notifyStatusLine = `\n⚠️ Client copy could not be sent: ${mailErr.message}`;
      }
    }

    return {
      notifyStatusLine,
      leadCellPhone: enrichment?.phone || undefined,
      leadLinkedinUrl: enrichment?.linkedinUrl || undefined,
      leadWebsite: enrichment?.website || undefined,
    };
  }

  if (reply.platform === 'heyreach') {
    const ctx = typeof reply.thread_context === 'string' ? JSON.parse(reply.thread_context) : reply.thread_context;
    const meta = ctx?.heyreach || {};
    await heyreach.sendMessage(
      client.heyreach_api_key,
      meta.listId,
      meta.linkedinAccountId,
      meta.linkedinUrl || reply.linkedin_url,
      replyText
    );
    return {};
  }

  throw new Error(`Unknown platform: ${reply.platform}`);
}

/**
 * After a human-approved message is sent, optionally book calendar for MEETING_PROPOSED.
 * Returns a status line suffix (empty string if none).
 */
async function maybeBookMeetingAfterSend(reply, client) {
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

module.exports = { sendReplyToPlatform, maybeBookMeetingAfterSend };
