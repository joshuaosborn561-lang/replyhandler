const { Router } = require('express');
const db = require('../db');
const {
  fetchSlackSentTrainingPairs,
  buildVoicePromptFromExamples,
  toGeminiJsonl,
  syncVoicePromptForClient,
  auditClientBookingLinks,
} = require('../services/voice-training');

const router = Router();

function webhookUrls(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + (process.env.PORT || 3000);
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return {
    smartlead_webhook_url: `${protocol}://${domain}/webhook/smartlead/${clientId}`,
    heyreach_webhook_url: `${protocol}://${domain}/webhook/heyreach/${clientId}`,
  };
}

function formatClient(client) {
  return { ...client, ...webhookUrls(client.id) };
}

// Create client
router.post('/admin/clients', async (req, res) => {
  try {
    const {
      name, smartlead_api_key, heyreach_api_key, slack_bot_token,
      slack_channel_id, booking_link, calendly_personal_access_token, voice_prompt, digest_timezone,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (name, smartlead_api_key, heyreach_api_key, slack_bot_token, slack_channel_id, booking_link, calendly_personal_access_token, voice_prompt, digest_timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        name,
        smartlead_api_key || null,
        heyreach_api_key || null,
        slack_bot_token,
        slack_channel_id,
        booking_link || null,
        calendly_personal_access_token || null,
        voice_prompt || '',
        digest_timezone || null,
      ]
    );

    console.log('[Admin] Client created', { id: client.id, name: client.name });
    res.status(201).json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Create client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List clients
router.get('/admin/clients', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(rows.map(formatClient));
  } catch (err) {
    console.error('[Admin] List clients error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update client
router.patch('/admin/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const fields = req.body;
    const allowedFields = [
      'name', 'smartlead_api_key', 'heyreach_api_key', 'slack_bot_token',
      'slack_channel_id', 'booking_link', 'calendly_personal_access_token', 'voice_prompt', 'active', 'digest_timezone',
    ];

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowedFields.includes(key)) {
        updates.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = now()`);
    values.push(clientId);

    const { rows: [client] } = await db.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('[Admin] Client updated', { id: client.id, name: client.name });
    res.json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Update client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Slack-sent replies for Gemini voice training
router.get('/admin/voice-training/sent-replies', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const clientId = req.query.clientId || null;
    const pairs = await fetchSlackSentTrainingPairs({ clientId, limit });
    res.json({
      count: pairs.length,
      pairs,
      voicePromptPreview: buildVoicePromptFromExamples(pairs),
    });
  } catch (err) {
    console.error('[Admin] Voice training export error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/voice-training/sent-replies.jsonl', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '200', 10);
    const clientId = req.query.clientId || null;
    const pairs = await fetchSlackSentTrainingPairs({ clientId, limit });
    res.type('application/x-ndjson').send(toGeminiJsonl(pairs));
  } catch (err) {
    console.error('[Admin] Voice training JSONL export error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Build clients.voice_prompt from Slack-approved sent replies
router.post('/admin/voice-training/sync-voice-prompt', async (req, res) => {
  try {
    const { clientId, limit, maxExamples, mergeManual } = req.body || {};
    if (clientId) {
      const result = await syncVoicePromptForClient(clientId, { limit, maxExamples, mergeManual });
      return res.json(result);
    }

    const { rows: clients } = await db.query(
      `SELECT id, name FROM clients WHERE active IS DISTINCT FROM false ORDER BY name`
    );
    const results = [];
    for (const c of clients) {
      results.push({
        clientId: c.id,
        clientName: c.name,
        ...(await syncVoicePromptForClient(c.id, { limit, maxExamples, mergeManual })),
      });
    }
    res.json({ clients: results });
  } catch (err) {
    console.error('[Admin] Voice prompt sync error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/booking-links/audit', async (_req, res) => {
  try {
    const clients = await auditClientBookingLinks();
    const active = clients.filter((c) => c.active);
    res.json({
      allActiveHaveBookingLink: active.every((c) => c.hasBookingLink),
      clients,
    });
  } catch (err) {
    console.error('[Admin] Booking link audit error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
