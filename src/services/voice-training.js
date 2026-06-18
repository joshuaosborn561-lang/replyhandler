const db = require('../db');

const BOOKING_DRAFT_CLASSIFICATIONS = new Set([
  'INTERESTED', 'QUESTION', 'OBJECTION', 'OTHER', 'MEETING_PROPOSED',
]);

function effectiveSentText(row) {
  const sent = String(row?.sent_reply || '').trim();
  if (sent) return sent;
  return String(row?.draft_reply || '').trim();
}

function trimPreview(text, max = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Slack-approved/edited replies stored in pending_replies.sent_reply.
 */
async function fetchSlackSentTrainingPairs({ clientId, limit = 100 } = {}) {
  const params = [Math.min(Math.max(limit, 1), 500)];
  let clientFilter = '';
  if (clientId) {
    clientFilter = 'AND pr.client_id = $2';
    params.push(clientId);
  }

  const { rows } = await db.query(
    `SELECT pr.id, pr.client_id, pr.platform, pr.lead_name, pr.classification,
            pr.inbound_message, pr.draft_reply, pr.sent_reply, pr.updated_at,
            c.name AS client_name, c.booking_link
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.status = 'sent'
        AND c.active IS DISTINCT FROM false
        AND (
          (pr.sent_reply IS NOT NULL AND btrim(pr.sent_reply) <> '')
          OR (pr.draft_reply IS NOT NULL AND btrim(pr.draft_reply) <> '')
        )
        ${clientFilter}
      ORDER BY pr.updated_at DESC
      LIMIT $1`,
    params
  );

  return rows.map((row) => {
    const outbound = effectiveSentText(row);
    const wasEdited = Boolean(
      row.sent_reply &&
      row.draft_reply &&
      String(row.sent_reply).trim() !== String(row.draft_reply).trim()
    );
    return {
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      platform: row.platform,
      leadName: row.lead_name,
      classification: row.classification,
      inboundMessage: row.inbound_message,
      outboundReply: outbound,
      wasEdited,
      sentAt: row.updated_at,
      bookingLink: row.booking_link || null,
    };
  }).filter((p) => p.outboundReply);
}

function buildVoicePromptFromExamples(pairs, { maxExamples = 12 } = {}) {
  const examples = pairs.slice(0, maxExamples);
  if (!examples.length) {
    return '';
  }

  const blocks = examples.map((ex, i) => {
    const inbound = trimPreview(ex.inboundMessage, 300);
    const outbound = trimPreview(ex.outboundReply, 500);
    const edited = ex.wasEdited ? ' (edited before send)' : '';
    return (
      `Example ${i + 1}${edited}:\n` +
      `Prospect: ${inbound || '(no inbound captured)'}\n` +
      `Our reply: ${outbound}`
    );
  });

  return (
    'Match the tone, length, and phrasing of these real replies we sent via Slack:\n\n' +
    blocks.join('\n\n')
  );
}

function toGeminiJsonl(pairs) {
  return pairs.map((ex) => JSON.stringify({
    input: {
      prospect_message: ex.inboundMessage,
      lead_name: ex.leadName,
      classification: ex.classification,
      platform: ex.platform,
      client: ex.clientName,
    },
    output: ex.outboundReply,
  })).join('\n');
}

async function syncVoicePromptForClient(clientId, { limit = 50, maxExamples = 12, mergeManual = true } = {}) {
  const pairs = await fetchSlackSentTrainingPairs({ clientId, limit });
  const generated = buildVoicePromptFromExamples(pairs, { maxExamples });
  if (!generated) {
    return { updated: false, reason: 'no_sent_replies', pairCount: 0 };
  }

  const { rows: [client] } = await db.query('SELECT voice_prompt FROM clients WHERE id = $1', [clientId]);
  if (!client) return { updated: false, reason: 'client_not_found', pairCount: pairs.length };

  let voicePrompt = generated;
  const manual = String(client.voice_prompt || '').trim();
  if (mergeManual && manual && !manual.includes('Match the tone, length, and phrasing of these real replies')) {
    voicePrompt = `${manual}\n\n${generated}`;
  }

  await db.query('UPDATE clients SET voice_prompt = $1, updated_at = now() WHERE id = $2', [
    voicePrompt,
    clientId,
  ]);

  return { updated: true, pairCount: pairs.length, voicePromptLength: voicePrompt.length };
}

async function auditClientBookingLinks() {
  const { rows } = await db.query(
    `SELECT id, name, active, booking_link, calendly_personal_access_token
       FROM clients
      ORDER BY active DESC, name ASC`
  );
  return rows.map((c) => {
    const link = c.booking_link && String(c.booking_link).trim();
    const hasBookingLink = Boolean(link && link.startsWith('http'));
    return {
      id: c.id,
      name: c.name,
      active: c.active !== false,
      bookingLink: link || null,
      hasBookingLink,
      hasCalendlyToken: Boolean(c.calendly_personal_access_token),
      calendlyLiveSlots: Boolean(
        hasBookingLink &&
        c.calendly_personal_access_token &&
        /calendly\.com/i.test(link)
      ),
    };
  });
}

function shouldAppendBookingLink(classification) {
  return BOOKING_DRAFT_CLASSIFICATIONS.has(classification);
}

module.exports = {
  fetchSlackSentTrainingPairs,
  buildVoicePromptFromExamples,
  toGeminiJsonl,
  syncVoicePromptForClient,
  auditClientBookingLinks,
  shouldAppendBookingLink,
  effectiveSentText,
};
