const crypto = require('crypto');
const { Router } = require('express');
const db = require('../db');
const { runWeeklyVoiceLearning } = require('../services/weekly-voice-learning');
const voiceProfile = require('../services/voice-profile');
const { renderLearnedVoiceBlock } = voiceProfile;

const router = Router();

const PROFILE_SELECT = `
  SELECT vp.id, vp.scope, vp.client_id, c.name AS client_name, vp.week_ending::text AS week_ending, vp.profile,
         vp.examples_used, vp.edited_used, vp.manual_used, vp.model, vp.trigger,
         vp.restored_from, vp.note, vp.created_at
    FROM voice_profiles vp
    LEFT JOIN clients c ON c.id = vp.client_id`;

function migrationError(res, err) {
  const missing = /relation .*voice_profiles.* does not exist|column .* does not exist/i.test(err.message);
  res.status(missing ? 404 : 500).json({
    error: missing ? 'voice_profiles not migrated — run migrations/025_voice_profiles.sql' : err.message,
  });
}

/**
 * `client` query param → { scope, clientId, clientName }. Missing or "global"
 * means the global profile. Unknown client name → null (caller sends 404).
 */
async function resolveScope(req) {
  const name = String(req.query.client || req.body?.client || '').trim();
  if (!name || name.toLowerCase() === 'global') return { scope: 'global', clientId: null, clientName: null };
  const clientId = await voiceProfile.resolveClientId({ clientName: name });
  if (!clientId) return null;
  return { scope: 'client', clientId, clientName: name };
}

/**
 * Group rows (newest first) by scope/client; the first in each group is the
 * one drafts use. Adds `active`, `versions`, and a human `label`.
 */
function annotateActive(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.scope}|${r.client_id || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    group.forEach((r, i) => out.push({
      ...r,
      label: r.scope === 'global' ? 'global' : r.client_name,
      active: i === 0,
      versions: group.length,
    }));
  }
  return out;
}

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
 * The profile drafts are using right now (newest version) for global and each
 * client, plus the rendered prompt block a draft for that client would receive.
 */
router.get('/admin/voice-learning/profiles', async (req, res) => {
  if (!assertSecret(req, res)) return;
  try {
    const { rows: all } = await db.query(`${PROFILE_SELECT} ORDER BY vp.created_at DESC`);
    const rows = annotateActive(all).filter((r) => r.active);
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
    migrationError(res, err);
  }
});

/**
 * GET /admin/voice-learning/history?secret=…[&client=<name>|global]
 * Every stored version, newest first, with `active` marking the one drafts
 * use. Nothing is ever deleted from this list; any `id` here can be reverted to.
 */
router.get('/admin/voice-learning/history', async (req, res) => {
  if (!assertSecret(req, res)) return;
  try {
    const filter = String(req.query.client || '').trim();
    let where = '';
    const params = [];
    if (filter.toLowerCase() === 'global') {
      where = `WHERE vp.scope = 'global'`;
    } else if (filter) {
      const target = await resolveScope(req);
      if (!target) return res.status(404).json({ error: `unknown client "${filter}"` });
      where = `WHERE vp.client_id = $1`;
      params.push(target.clientId);
    }
    const { rows } = await db.query(`${PROFILE_SELECT} ${where} ORDER BY vp.created_at DESC`, params);
    const versions = annotateActive(rows).map(({ versions: _v, ...r }) => r);
    res.json({
      count: versions.length,
      versions,
      howToRevert: 'POST /admin/voice-learning/revert?secret=…&id=<id>   or   &client=<name>|global&previous=1',
    });
  } catch (err) {
    migrationError(res, err);
  }
});

/**
 * POST /admin/voice-learning/revert?secret=…&id=<profile id>[&note=…]
 * POST /admin/voice-learning/revert?secret=…&client=<name>|global&previous=1[&note=…]
 *
 * Copies the chosen version forward as the new current one. Drafts switch to
 * it and the Friday job keeps auto-updating from it. The version being
 * reverted away from stays in history. `previous=1` = one week back.
 */
router.post('/admin/voice-learning/revert', async (req, res) => {
  if (!assertSecret(req, res)) return;
  const id = String(req.query.id || req.body?.id || '').trim();
  const note = String(req.query.note || req.body?.note || '').trim() || null;
  try {
    let restored;
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id must be a voice_profiles uuid' });
      restored = await voiceProfile.restoreProfile(id, { note });
    } else if (flag(req.query.previous ?? req.body?.previous)) {
      const target = await resolveScope(req);
      if (!target) return res.status(404).json({ error: `unknown client "${req.query.client}"` });
      restored = await voiceProfile.restorePreviousProfile({ ...target, note });
    } else {
      return res.status(400).json({ error: 'pass id=<profile id>, or client=<name>|global with previous=1' });
    }
    res.json({
      reverted: true,
      nowActive: restored,
      note: 'Drafts use this version within 10 minutes (prompt cache). Weekly updates continue from it; revert again any time from /history.',
    });
  } catch (err) {
    if (/not found|nothing earlier|no stored voice profile/i.test(err.message)) {
      return res.status(404).json({ error: err.message });
    }
    migrationError(res, err);
  }
});

module.exports = router;
