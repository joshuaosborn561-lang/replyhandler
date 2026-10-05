const db = require('../db');
const smartlead = require('./smartlead');
const heyreach = require('./heyreach');
const calendar = require('./calendar');
const { parseProposedTime } = require('../utils/parse-proposed-time');
const { buildSmartleadCcList, alwaysCcEmails, roundRobinEmails } = require('./client-cc');
const { enrichProspect } = require('./prospect-enrich');
const { buildClientNotifyEmail, pickRicherThreadContext } = require('./client-notify-email');
const gmail = require('./gmail-send');
const clientClaimed = require('./client-claimed');
const { alreadySentSameOutbound } = require('./reply-dedupe');

/** Rows created by POST /admin/test/slack-draft — not real SmartLead/HeyReach leads */
function isSlackTestFixtureReply(reply) {
  return reply.campaign_id === 'test-campaign' && reply.lead_id === 'test-lead';
}

function isFollowUpPlaceholder(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
}

/**
 * Live SmartLead history + prior approved sends, so a FOLLOW_UP notify
 * includes the first reply — not just the inbound-time snapshot.
 */
async function resolveClientNotifyThread(client, reply) {
  let live = null;
  const leadIdNumeric = reply.lead_id != null && /^\d+$/.test(String(reply.lead_id).trim());
  if (
    reply.platform === 'smartlead'
    && client.smartlead_api_key
    && reply.campaign_id
    && leadIdNumeric
  ) {
    try {
      live = await smartlead.getThreadHistory(
        client.smartlead_api_key,
        reply.campaign_id,
        reply.lead_id,
      );
    } catch (err) {
      console.warn('[ReplySend] Live thread history for client notify failed', {
        replyId: reply.id, err: err.message,
      });
    }
  }

  const extraMessages = [];
  if (reply.client_id && reply.platform) {
    try {
      const { rows } = await db.query(
        `SELECT id, sent_reply, inbound_message, classification, updated_at
           FROM pending_replies
          WHERE client_id = $1
            AND platform = $2
            AND status = 'sent'
            AND sent_reply IS NOT NULL
            AND trim(sent_reply) <> ''
            AND ($5::uuid IS NULL OR id <> $5)
            AND (
              ($3::text <> '' AND COALESCE(lead_id, '') = $3)
              OR ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
            )
          ORDER BY updated_at ASC
          LIMIT 20`,
        [
          reply.client_id,
          reply.platform,
          reply.lead_id != null ? String(reply.lead_id) : '',
          reply.lead_email ? String(reply.lead_email).trim().toLowerCase() : '',
          reply.id || null,
        ],
      );
      for (const r of rows) {
        if (
          r.inbound_message
          && !isFollowUpPlaceholder(r.inbound_message)
          && String(r.classification || '').toUpperCase() !== 'FOLLOW_UP'
        ) {
          extraMessages.push({
            type: 'REPLY',
            email_body: r.inbound_message,
            time: r.updated_at,
          });
        }
        extraMessages.push({
          type: 'SENT',
          email_body: r.sent_reply,
          time: r.updated_at,
        });
      }
    } catch (err) {
      console.warn('[ReplySend] Prior-send lookup for client notify failed', {
        replyId: reply.id, err: err.message,
      });
    }
  }

  return {
    threadContext: pickRicherThreadContext(live, reply.thread_context),
    extraMessages,
  };
}

async function sendReplyToPlatform(client, reply, replyText) {
  if (isSlackTestFixtureReply(reply)) {
    console.log('[ReplySend] Skipping outbound API — Slack test fixture', { replyId: reply.id, platform: reply.platform });
    return;
  }

  // Portal takeover: do not send if the client already claimed this lead.
  await clientClaimed.assertNotClaimedOrThrow(reply);

  // Two Slack cards for one inbound (webhook + poller race) can both be
  // approved. Do not deliver the same outbound twice (Casey Buckstaff).
  if (await alreadySentSameOutbound({
    clientId: reply.client_id,
    platform: reply.platform,
    leadId: reply.lead_id,
    leadEmail: reply.lead_email,
    replyText,
    exceptReplyId: reply.id,
  })) {
    console.warn('[ReplySend] Skipping outbound — same text already sent to this person', {
      replyId: reply.id, lead: reply.lead_name, platform: reply.platform,
    });
    return { skippedDuplicate: true };
  }

  if (reply.platform === 'smartlead') {
    // Primary: the stats_id captured at webhook ingestion.
    // Fallback: resolve live from message-history (for older rows that predate the column).
    let emailStatsId = reply.smartlead_email_stats_id || null;
    const leadId = reply.lead_id;
    const leadIdNumeric = leadId != null && /^\d+$/.test(String(leadId).trim());
    if (!emailStatsId && leadIdNumeric) {
      console.log('[ReplySend] SmartLead stats_id missing on row — resolving live', {
        replyId: reply.id, campaignId: reply.campaign_id, leadId: reply.lead_id,
      });
      emailStatsId = await smartlead.resolveEmailStatsId(client.smartlead_api_key, reply.campaign_id, leadId);
      if (emailStatsId) {
        await db.query('UPDATE pending_replies SET smartlead_email_stats_id = $1 WHERE id = $2', [emailStatsId, reply.id]);
      }
    } else if (!emailStatsId && !leadIdNumeric) {
      console.warn('[ReplySend] SmartLead stats_id missing and lead_id is not numeric — cannot resolve from history', {
        replyId: reply.id, campaignId: reply.campaign_id, leadId: reply.lead_id,
      });
    }

    // Deliverability: reply to the prospect with NO CC.
    // Then notify Always-forward + round-robin from primary Gmail with thread + enrichment.
    const hasForwardConfig = alwaysCcEmails(client).length > 0 || roundRobinEmails(client).length > 0;
    let forwardEmails = '';
    let ccMeta = null;
    if (hasForwardConfig) {
      ccMeta = await buildSmartleadCcList(client, { claimRoundRobin: true });
      forwardEmails = ccMeta.ccEmails;
    }

    let clientCcWarning = '';
    let clientCcMode = '';
    let enrichment = null;

    await smartlead.sendReply(
      client.smartlead_api_key,
      reply.campaign_id,
      reply.lead_id,
      { replyText, emailStatsId }
    );

    if (forwardEmails) {
      try {
        if (reply.phone_enrichment_status === 'found' ||
            reply.phone_enrichment_status === 'not_found') {
          enrichment = {
            email: reply.lead_email || null,
            phone: reply.lead_phone || null,
            linkedinUrl: reply.linkedin_url || null,
            website: reply.lead_website || null,
            sources: {
              email: reply.lead_email ? 'reply' : null,
              phone: reply.lead_phone_provider || null,
            },
          };
        } else {
          enrichment = await enrichProspect({
            email: reply.lead_email,
            linkedinUrl: reply.linkedin_url,
            leadName: reply.lead_name,
          });
        }
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

      const { threadContext, extraMessages } = await resolveClientNotifyThread(client, reply);
      const notify = buildClientNotifyEmail({
        leadName: reply.lead_name,
        leadEmail: reply.lead_email,
        clientName: client.name,
        campaignName: reply.campaign_name || reply.campaign_id,
        enrichment,
        threadContext,
        extraMessages,
        inboundMessage: reply.inbound_message,
        sentText: replyText,
      });

      try {
        if (!gmail.isConfigured()) {
          throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured');
        }
        const account = await gmail.getAccount();
        if (!account) {
          throw new Error(`Primary Gmail not connected — open /auth/gmail/connect (login as ${gmail.expectedFromEmail()})`);
        }

        await gmail.sendMail({
          to: forwardEmails,
          subject: notify.subject,
          htmlBody: notify.htmlBody,
          textBody: notify.textBody,
        });
        clientCcMode = 'gmail';
        console.log('[ReplySend] Client notify sent from primary Gmail', {
          replyId: reply.id,
          to: forwardEmails,
          from: account.email,
          always: ccMeta?.always,
          roundRobin: ccMeta?.roundRobin,
          cellPhone: enrichment?.phone || null,
          linkedin: enrichment?.linkedinUrl || null,
          sources: enrichment?.sources || null,
        });
      } catch (mailErr) {
        // Fallback: SmartLead forward so the client still gets a copy.
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
          clientCcMode = 'forward';
          clientCcWarning = `Primary Gmail failed (${mailErr.message}); used SmartLead forward instead`;
        } catch (fwdErr) {
          console.error('[ReplySend] Client copy failed (reply still sent)', {
            replyId: reply.id, gmailErr: mailErr.message, fwdErr: fwdErr.message,
          });
          clientCcWarning = `Client copy could not be sent: ${mailErr.message}`;
        }
      }
    }

    return {
      clientCcWarning: clientCcWarning || undefined,
      clientCcMode: clientCcMode || undefined,
      clientCcEmails: forwardEmails || undefined,
      clientCcRoundRobin: ccMeta?.roundRobin || undefined,
      leadCellPhone: enrichment?.phone || undefined,
      leadCellPhoneProvider: enrichment?.sources?.phone || undefined,
      leadLinkedinUrl: enrichment?.linkedinUrl || undefined,
      leadWebsite: enrichment?.website || undefined,
    };
  }

  if (reply.platform === 'heyreach') {
    const ctx = typeof reply.thread_context === 'string' ? JSON.parse(reply.thread_context) : reply.thread_context;
    const meta = ctx?.heyreach || {};
    await heyreach.sendMessage(client.heyreach_api_key, {
      conversationId: meta.conversationId || null,
      linkedInAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null,
      senderId: meta.senderId || null,
      listId: meta.listId || null,
      linkedinUrl: meta.linkedinUrl || reply.linkedin_url || null,
      message: replyText,
    });
    return;
  }

  throw new Error(`Unknown platform: ${reply.platform}`);
}

/**
 * After a human-approved message is sent, optionally book calendar for MEETING_PROPOSED.
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

module.exports = {
  sendReplyToPlatform,
  maybeBookMeetingAfterSend,
  isSlackTestFixtureReply,
  resolveClientNotifyThread,
};
