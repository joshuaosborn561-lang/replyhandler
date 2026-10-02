const crypto = require('crypto');
const { Router } = require('express');
const db = require('../db');
const { runWeeklyVoiceLearning } = require('../services/weekly-voice-learning');
const { renderLearnedVoiceBlock } = require('../services/voice-profile');

const router = Router();

/** Same gate as /admin/test/*: 404 when unset, timing-safe compare. */
function assertSecret(req, res) {
  const secret = process.env.WEBHOOK_TEST_SECRET;
  if (!secret) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const token = req.get('x-webhook-test-secret') || req.query.secret;
  const a = Buffer.from(String(token || ''), 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return secret;
}

function flag(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

/**
 * POST /admin/voice-learning/run?secret=…&hours=192&dry=1
 * Runs the Friday job now. `dry=1` collects and synthesizes but writes nothing
 * (profiles are returned inline as preview:*). Runs inline; expect 30–120s.
 */
router.post('/admin/voice-learning/run', async (req, res) => {
  if (!assertSecret(req, res)) return;
  const hours = parseInt(req.query.hours || req.body?.hours || '', 10);
  const dryRun = flag(req.query.dry ?? req.body?.dry);
  try {
    const summary = await runWeeklyVoiceLearning({
      lookbackHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
      dryRun,
      trigger: dryRun ? 'admin_dry_run' : 'admin',
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/voice-learning/profiles?secret=…[&client=<name>]
 * Latest global profile, latest per-client profiles, and the rendered prompt
 * block a draft for that client would receive.
 */
router.get('/admin/voice-learning/profiles', async (req, res) => {
  if (!assertSecret(req, res)) return;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (vp.scope, vp.client_id)
              vp.scope, vp.client_id, c.name AS client_name, vp.week_ending, vp.profile,
              vp.examples_used, vp.edited_used, vp.manual_used, vp.model, vp.created_at
         FROM voice_profiles vp
         LEFT JOIN clients c ON c.id = vp.client_id
        ORDER BY vp.scope, vp.client_id, vp.week_ending DESC, vp.created_at DESC`
    );
    const global = rows.find((r) => r.scope === 'global') || null;
    let clients = rows.filter((r) => r.scope === 'client');
    const filter = String(req.query.client || '').trim().toLowerCase();
    if (filter) clients = clients.filter((r) => String(r.client_name || '').toLowerCase() === filter);

    const rendered = clients.map((r) => ({
      client: r.client_name,
      block: renderLearnedVoiceBlock({ global: global?.profile, client: r.profile, clientName: r.client_name }),
    }));
    if (!clients.length) {
      rendered.push({ client: null, block: renderLearnedVoiceBlock({ global: global?.profile }) });
    }

    const { rows: runs } = await db.query(
      `SELECT id, started_at, finished_at, lookback_hours, trigger, dry_run, error,
              summary->'rag' AS rag, summary->'profiles' AS profiles
         FROM voice_learning_runs
        ORDER BY started_at DESC
        LIMIT 5`
    ).catch(() => ({ rows: [] }));

    res.json({ global, clients, rendered, recentRuns: runs });
  } catch (err) {
    const missing = /relation .*voice_profiles.* does not exist/i.test(err.message);
    res.status(missing ? 404 : 500).json({
      error: missing ? 'voice_profiles not migrated — run migrations/025_voice_profiles.sql' : err.message,
    });
  }
});

module.exports = router;
