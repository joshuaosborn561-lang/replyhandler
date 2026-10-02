#!/usr/bin/env node
/**
 * Browse and revert learned voice profiles.
 *
 * Every Friday run stores a NEW version; nothing is ever overwritten or
 * deleted. "Revert" copies an earlier version forward as the new current one,
 * so drafts switch to it and the weekly job keeps auto-updating from there.
 * The version you reverted away from stays in the list.
 *
 * Usage:
 *   railway run node scripts/voice-profile-revert.js list                      # all versions, newest first
 *   railway run node scripts/voice-profile-revert.js list --client SalesGlider
 *   railway run node scripts/voice-profile-revert.js show <id>                 # full profile JSON
 *   railway run node scripts/voice-profile-revert.js revert --previous [--client Name]   # one week back
 *   railway run node scripts/voice-profile-revert.js revert <id> [--note "..."]          # a specific version
 *
 * `--client` omitted (or "global") means the global profile. Needs DATABASE_URL.
 */
const { resolveDatabaseUrl } = require('./railway-database-url');

const url = resolveDatabaseUrl();
if (url) process.env.DATABASE_URL = url;

const db = require('../src/db');
const voiceProfile = require('../src/services/voice-profile');

const args = process.argv.slice(2);
const command = args[0];

function opt(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const hasFlag = (name) => args.includes(name);

async function scopeFromArgs() {
  const name = (opt('--client') || '').trim();
  if (!name || name.toLowerCase() === 'global') return { scope: 'global', clientId: null, label: 'global' };
  const clientId = await voiceProfile.resolveClientId({ clientName: name });
  if (!clientId) throw new Error(`unknown client "${name}"`);
  return { scope: 'client', clientId, label: name };
}

function summarize(profile) {
  const p = profile || {};
  const n = (k) => (Array.isArray(p[k]) ? p[k].length : 0);
  return `${n('voice_rules')} rules / ${n('signature_phrases')} phrases / ${n('avoid')} avoid / ${n('client_notes')} notes`;
}

async function list() {
  const filter = (opt('--client') || '').trim();
  const params = [];
  let where = '';
  if (filter.toLowerCase() === 'global') {
    where = `WHERE vp.scope = 'global'`;
  } else if (filter) {
    const { clientId } = await scopeFromArgs();
    where = 'WHERE vp.client_id = $1';
    params.push(clientId);
  }
  const { rows } = await db.query(
    `SELECT vp.id, vp.scope, vp.client_id, c.name AS client_name, vp.week_ending::text AS week_ending, vp.profile,
            vp.examples_used, vp.trigger, vp.restored_from, vp.note, vp.created_at
       FROM voice_profiles vp
       LEFT JOIN clients c ON c.id = vp.client_id
       ${where}
      ORDER BY vp.scope, c.name NULLS FIRST, vp.created_at DESC`,
    params
  );
  if (!rows.length) {
    console.log('No stored voice profiles yet. The Friday job (or scripts/run-weekly-voice-learning.js) creates the first one.');
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = r.scope === 'global' ? 'global' : r.client_name || r.client_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [label, group] of groups) {
    console.log(`\n== ${label} (${group.length} version${group.length === 1 ? '' : 's'})`);
    group.forEach((r, i) => {
      const marks = [];
      if (i === 0) marks.push('CURRENT');
      if (r.restored_from) marks.push(`restored from ${r.restored_from.slice(0, 8)}${r.note ? ` — "${r.note}"` : ''}`);
      const created = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `  ${r.id}  week ${r.week_ending}  saved ${created}  ${String(r.examples_used).padStart(3)} ex  ${summarize(r.profile)}` +
        `  [${r.trigger || '-'}]${marks.length ? '  <- ' + marks.join(', ') : ''}`
      );
    });
  }
  console.log('\nrevert one week back:  node scripts/voice-profile-revert.js revert --previous [--client Name]');
  console.log('revert to a version:   node scripts/voice-profile-revert.js revert <id>');
}

async function show(id) {
  if (!id) throw new Error('usage: show <id>');
  const { rows: [row] } = await db.query(
    `SELECT vp.*, vp.week_ending::text AS week_ending, c.name AS client_name
       FROM voice_profiles vp LEFT JOIN clients c ON c.id = vp.client_id WHERE vp.id = $1`,
    [id]
  );
  if (!row) throw new Error(`voice profile ${id} not found`);
  console.log(JSON.stringify(row, null, 2));
}

async function revert() {
  const note = opt('--note') || null;
  let restored;
  if (hasFlag('--previous')) {
    const target = await scopeFromArgs();
    restored = await voiceProfile.restorePreviousProfile({ scope: target.scope, clientId: target.clientId, note });
  } else {
    const id = args[1];
    if (!id || id.startsWith('--')) throw new Error('usage: revert <id> [--note "..."]  or  revert --previous [--client Name]');
    restored = await voiceProfile.restoreProfile(id, { note });
  }
  let label = 'global';
  if (restored.client_id) {
    const { rows: [c] } = await db.query('SELECT name FROM clients WHERE id = $1', [restored.client_id]);
    label = `client ${c?.name || restored.client_id}`;
  }
  console.log(`Reverted ${label} to the ${restored.week_ending} version (new current version ${restored.id}).`);
  console.log('Drafts switch to it within 10 minutes (prompt cache). Weekly updates continue from here; run `list` to revert again.');
}

(async () => {
  try {
    switch (command) {
      case 'list': await list(); break;
      case 'show': await show(args[1]); break;
      case 'revert': await revert(); break;
      default:
        console.error('usage: voice-profile-revert.js list [--client Name] | show <id> | revert --previous [--client Name] | revert <id> [--note "..."]');
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(`[VoiceProfile] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
