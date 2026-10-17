const { Router } = require('express');
const { verifyAlloWebhookSignature } = require('../utils/allo-webhook-signature');
const { handleAlloWebhookEvent } = require('../services/allo-meetings');

const router = Router();

function rawBodyOf(req) {
  if (req.rawBody != null && req.rawBody !== '') return req.rawBody;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

/**
 * Allo Settings → Webhooks (or POST /v2/api/webhooks with WEBHOOKS_READ_WRITE).
 *
 * POST /webhook/allo
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 * Topics: call.completed, tag.added
 */
router.post('/webhook/allo', async (req, res) => {
  const secret = process.env.ALLO_WEBHOOK_SIGNING_SECRET;
  const verified = verifyAlloWebhookSignature({
    rawBody: rawBodyOf(req),
    headers: req.headers,
    secret,
  });
  if (!verified.ok) {
    return res.status(verified.status).json({ ok: false, error: verified.error });
  }

  try {
    const result = await handleAlloWebhookEvent(req.body || {}, {
      webhookId: verified.webhookId,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[AlloMeetings] webhook handler error', { err: err.message, stack: err.stack });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
