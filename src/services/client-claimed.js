const crypto = require('crypto');
const db = require('../db');
const slack = require('./slack');

const CLAIM_STATUSES = new Set(['client_has_it', 'booked_offline', 'not_a_fit']);
const STATUS_LABELS = {
  client_has_it: 'Client is taking this lead',
  booked_offline: 'Client booked this offline',
  not_a_fit: 'Client marked this not a fit',
  open: 'Client released this lead',
};

function normalizeEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  return s.includes('@') ? s : '';
}

function normalizeCampaignId(value) {
  return String(value == null ? '' : value).trim();
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function assertPortalSecret(req) {
  const secret = String(process.env.PORTAL_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return { ok: false, status: 503, error: 'portal_webhook_not_configured' };
  }
  const got = String(req.get?.('x-portal-secret') || req.headers?.['x-portal-secret'] || '').trim();
  if (!timingSafeEqualString(got, secret)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function parseClientAction(body) {
  const b = body && typeof body === 'object' ? body : {};
  const leadEmail = normalizeEmail(b.email || b.lead_email);
  const campaignId = normalizeCampaignId(b.campaign_id);
  const status = String(b.status || '').trim();
  const type = String(b.type || '').trim().toLowerCase();
  const note = String(b.note || b.message || '').trim();
  return { leadEmail, campaignId, status, type, note };
}

function describeAction(action) {
  if (action.type === 'note') return `note:${action.note}`;
  if (action.status === 'open') return 'open';
  if (CLAIM_STATUSES.has(action.status)) return `claim:${action.status}`;
  return '';
}

async function isLeadClaimed({ leadEmail, campaignId } = {}) {
  const email = normalizeEmail(leadEmail);
  const camp = normalizeCampaignId(campaignId);
  if (!email || !camp) return false;
  const { rows: [row] } = await db.query(
    `SELECT claimed FROM client_claimed_leads
      WHERE lead_email = $1 AND campaign_id = $2
      LIMIT 1`,
    [email, camp]
  );
  return !!(row && row.claimed);
}

async function getClaim(leadEmail, campaignId) {
  const { rows: [row] } = await db.query(
    `SELECT * FROM client_claimed_leads
      WHERE lead_email = $1 AND campaign_id = $2
      LIMIT 1`,
    [leadEmail, campaignId]
  );
  return row || null;
}

async function cancelClaimedLeadWork({ leadEmail, campaignId }) {
  const email = normalizeEmail(leadEmail);
  const camp = normalizeCampaignId(campaignId);
  if (!email || !camp) return { followUps: 0, drafts: 0 };

  const followUps = await db.query(
    `UPDATE outbound_follow_ups
        SET status = 'cancelled', skip_reason = 'client_claimed', updated_at = now()
      WHERE status = 'pending'
        AND lower(COALESCE(lead_email, '')) = $1
        AND COALESCE(campaign_id, '') = $2`,
    [email, camp]
  );

  const drafts = await db.query(
    `UPDATE pending_replies
        SET status = 'suppressed',
            suppression_reason = 'client_claimed',
            updated_at = now()
      WHERE status IN ('pending', 'flagged')
        AND lower(COALESCE(lead_email, '')) = $1
        AND COALESCE(campaign_id, '') = $2`,
    [email, camp]
  );

  return {
    followUps: followUps.rowCount || 0,
    drafts: drafts.rowCount || 0,
  };
}

async function findClientForLead(leadEmail, campaignId) {
  const { rows: [fromReply] } = await db.query(
    `SELECT c.id, c.name, c.slack_bot_token, c.slack_channel_id
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE lower(COALESCE(pr.lead_email, '')) = $1
        AND COALESCE(pr.campaign_id, '') = $2
      ORDER BY pr.updated_at DESC
      LIMIT 1`,
    [leadEmail, campaignId]
  );
  if (fromReply) return fromReply;

  const { rows: [fromFu] } = await db.query(
    `SELECT c.id, c.name, c.slack_bot_token, c.slack_channel_id
       FROM outbound_follow_ups fu
       JOIN clients c ON c.id = fu.client_id
      WHERE lower(COALESCE(fu.lead_email, '')) = $1
        AND COALESCE(fu.campaign_id, '') = $2
      ORDER BY fu.updated_at DESC
      LIMIT 1`,
    [leadEmail, campaignId]
  );
  return fromFu || null;
}

async function leadDisplayName(leadEmail, campaignId) {
  const { rows: [row] } = await db.query(
    `SELECT lead_name FROM pending_replies
      WHERE lower(COALESCE(lead_email, '')) = $1 AND COALESCE(campaign_id, '') = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [leadEmail, campaignId]
  );
  if (row?.lead_name) return row.lead_name;
  const { rows: [fu] } = await db.query(
    `SELECT lead_name FROM outbound_follow_ups
      WHERE lower(COALESCE(lead_email, '')) = $1 AND COALESCE(campaign_id, '') = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [leadEmail, campaignId]
  );
  return fu?.lead_name || leadEmail;
}

async function attachNoteToDrafts({ leadEmail, campaignId, note }) {
  const { rows } = await db.query(
    `UPDATE pending_replies
        SET client_note = $3, updated_at = now()
      WHERE status IN ('pending', 'flagged')
        AND lower(COALESCE(lead_email, '')) = $1
        AND COALESCE(campaign_id, '') = $2
      RETURNING id, slack_message_ts, client_id, lead_name`,
    [leadEmail, campaignId, note]
  );
  return rows;
}

async function notifyCayden(client, text) {
  if (!client?.slack_bot_token || !client?.slack_channel_id) {
    console.warn('[ClientAction] No Slack channel for Cayden notice');
    return;
  }
  await slack.postClientActionNotice(
    client.slack_bot_token,
    client.slack_channel_id,
    text,
  );
}

async function applyClientAction(action, deps) {
  const d = deps || {
    getClaim,
    upsertClaim,
    cancelWork: cancelClaimedLeadWork,
    findClient: findClientForLead,
    leadName: leadDisplayName,
    attachNoteToDrafts,
    notifyCayden,
    postDraftThread: slack.postClientActionNotice,
  };

  if (!action.leadEmail || !action.campaignId) {
    return { ok: false, status: 400, error: 'email_and_campaign_id_required' };
  }

  const existing = await d.getClaim(action.leadEmail, action.campaignId);
  const client = await d.findClient(action.leadEmail, action.campaignId);
  const name = await d.leadName(action.leadEmail, action.campaignId);
  const who = `*${name}* · ${action.leadEmail} · campaign ${action.campaignId}`;

  if (action.type === 'note') {
    if (!action.note) {
      return { ok: false, status: 400, error: 'note_required' };
    }
    if (existing && String(existing.last_note || '') === action.note) {
      return { ok: true, unchanged: true, action: 'note' };
    }
    await d.upsertClaim({
      leadEmail: action.leadEmail,
      campaignId: action.campaignId,
      claimed: !!(existing && existing.claimed),
      status: existing?.status || null,
      lastNote: action.note,
      clientId: client?.id || existing?.client_id || null,
    });
    const drafts = await d.attachNoteToDrafts({
      leadEmail: action.leadEmail,
      campaignId: action.campaignId,
      note: action.note,
    });
    if (client) {
      await d.notifyCayden(client, `📝 Client note on ${who}:\n>${action.note}`);
      for (const draft of drafts || []) {
        if (draft.slack_message_ts && client.slack_bot_token && client.slack_channel_id) {
          await d.postDraftThread(
            client.slack_bot_token,
            client.slack_channel_id,
            `📝 Client note before you approve:\n>${action.note}`,
            draft.slack_message_ts,
          );
        }
      }
    }
    return { ok: true, unchanged: false, action: 'note', drafts: (drafts || []).length };
  }

  if (action.status === 'open') {
    if (!existing || !existing.claimed) {
      return { ok: true, unchanged: true, action: 'open' };
    }
    await d.upsertClaim({
      leadEmail: action.leadEmail,
      campaignId: action.campaignId,
      claimed: false,
      status: 'open',
      lastNote: existing.last_note || null,
      clientId: client?.id || existing.client_id || null,
      cleared: true,
    });
    if (client) {
      await d.notifyCayden(
        client,
        `🔓 ${STATUS_LABELS.open} — ${who}. Follow-ups were not restarted.`,
      );
    }
    return { ok: true, unchanged: false, action: 'open' };
  }

  if (CLAIM_STATUSES.has(action.status)) {
    if (existing?.claimed && existing.status === action.status) {
      return { ok: true, unchanged: true, action: 'claim', status: action.status };
    }
    const cancelled = await d.cancelWork({
      leadEmail: action.leadEmail,
      campaignId: action.campaignId,
    });
    await d.upsertClaim({
      leadEmail: action.leadEmail,
      campaignId: action.campaignId,
      claimed: true,
      status: action.status,
      lastNote: existing?.last_note || null,
      clientId: client?.id || existing?.client_id || null,
    });
    if (client) {
      await d.notifyCayden(
        client,
        `🛑 ${STATUS_LABELS[action.status]} — ${who}. Follow-ups and pending drafts cancelled.`,
      );
    }
    return { ok: true, unchanged: false, action: 'claim', status: action.status, cancelled };
  }

  return { ok: false, status: 400, error: 'unknown_action' };
}

async function upsertClaim({
  leadEmail, campaignId, claimed, status, lastNote, clientId, cleared,
}) {
  await db.query(
    `INSERT INTO client_claimed_leads
       (lead_email, campaign_id, status, claimed, last_note, client_id, claimed_at, cleared_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 THEN now() ELSE NULL END, CASE WHEN $7 THEN now() ELSE NULL END, now())
     ON CONFLICT (lead_email, campaign_id) DO UPDATE SET
       status = EXCLUDED.status,
       claimed = EXCLUDED.claimed,
       last_note = COALESCE(EXCLUDED.last_note, client_claimed_leads.last_note),
       client_id = COALESCE(EXCLUDED.client_id, client_claimed_leads.client_id),
       claimed_at = CASE
         WHEN EXCLUDED.claimed AND NOT client_claimed_leads.claimed THEN now()
         WHEN EXCLUDED.claimed THEN COALESCE(client_claimed_leads.claimed_at, now())
         ELSE client_claimed_leads.claimed_at
       END,
       cleared_at = CASE WHEN $7 THEN now() ELSE client_claimed_leads.cleared_at END,
       updated_at = now()`,
    [leadEmail, campaignId, status || null, !!claimed, lastNote || null, clientId || null, !!cleared]
  );
}

async function assertNotClaimedOrThrow(reply) {
  const email = reply?.lead_email;
  const campaignId = reply?.campaign_id;
  if (!(await isLeadClaimed({ leadEmail: email, campaignId }))) return;
  const cancelled = await cancelClaimedLeadWork({ leadEmail: email, campaignId });
  console.log('[ReplySend] Skip — client claimed this lead', {
    replyId: reply?.id,
    leadEmail: normalizeEmail(email),
    campaignId: normalizeCampaignId(campaignId),
    cancelled,
  });
  const err = new Error('client_claimed');
  err.code = 'client_claimed';
  throw err;
}

module.exports = {
  CLAIM_STATUSES,
  STATUS_LABELS,
  normalizeEmail,
  normalizeCampaignId,
  assertPortalSecret,
  parseClientAction,
  describeAction,
  isLeadClaimed,
  getClaim,
  cancelClaimedLeadWork,
  applyClientAction,
  assertNotClaimedOrThrow,
};
