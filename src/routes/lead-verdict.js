const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { leadVerdict } = require('../services/lead-verdict');

const router = Router();

function authorized(req) {
  const want = String(process.env.LEAD_VERDICT_TOKEN || '');
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!want || !got || want.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

router.post('/internal/lead-verdict', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });
  const body = req.body || {};
  if (!String(body.client_tag || '').trim()) {
    return res.status(400).json({ ok: false, reason: 'client_tag is required' });
  }
  try {
    return res.json(await leadVerdict(db, body));
  } catch (err) {
    console.error('[LeadVerdict] failed', { err: err.message });
    return res.status(500).json({ ok: false, reason: 'verdict_failed' });
  }
});

module.exports = router;
