/**
 * POST /admin/prospects/dq
 *
 * Disqualify one prospect the same way the Slack DQ button does
 * (markDisqualified). dryRun defaults to true.
 *
 * Auth matches POST /admin/onboarding/client: header ADMIN_API_KEY, or
 * x-admin-api-key. Unset ADMIN_API_KEY fails closed (503). The key is never
 * logged.
 *
 *   curl -s -X POST "$HOST/admin/prospects/dq" \
 *     -H "ADMIN_API_KEY: $ADMIN_API_KEY" \
 *     -H 'content-type: application/json' \
 *     -d '{"leadEmail":"person@example.com","clientId":"<uuid>","pendingReplyIds":["<uuid>"]}'
 *
 *   curl -s -X POST "$HOST/admin/prospects/dq" \
 *     -H "ADMIN_API_KEY: $ADMIN_API_KEY" \
 *     -H 'content-type: application/json' \
 *     -d '{"leadEmail":"person@example.com","clientId":"<uuid>","dryRun":false}'
 */
const { Router } = require('express');
const { requireAdminApiKey } = require('../utils/admin-auth');
const { dqProspect } = require('../services/admin-prospect-dq');

function requestInput(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const dryFromBody = body.dryRun !== undefined ? body.dryRun : body.dry_run;
  const dry = dryFromBody !== undefined
    ? dryFromBody
    : (req.query && req.query.dryRun !== undefined ? req.query.dryRun : req.query && req.query.dry);
  return { ...body, dryRun: dry };
}

function createProspectDqRouter(overrides = {}) {
  const router = Router();
  const gate = overrides.requireAdminApiKey || requireAdminApiKey;
  router.post('/admin/prospects/dq', gate, async (req, res) => {
    try {
      const out = await dqProspect(requestInput(req), overrides);
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error('[Admin] prospect dq failed', { err: err.message });
      res.status(500).json({ error: 'dq_failed' });
    }
  });
  return router;
}

const router = createProspectDqRouter();
router.createProspectDqRouter = createProspectDqRouter;
module.exports = router;
