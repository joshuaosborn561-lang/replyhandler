const { Router } = require('express');
const {
  assertPortalSecret,
  parseClientAction,
  applyClientAction,
} = require('../services/client-claimed');

const router = Router();

router.post('/client-action', async (req, res) => {
  const auth = assertPortalSecret(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const action = parseClientAction(req.body);
    const result = await applyClientAction(action);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.status(200).json({
      ok: true,
      unchanged: !!result.unchanged,
      action: result.action,
      status: result.status || null,
      cancelled: result.cancelled || undefined,
    });
  } catch (err) {
    console.error('[ClientAction] Failed', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
