#!/usr/bin/env node
/**
 * Replay the 50-row gold set against the production Jev prompt.
 *
 * Reads uploads/sample.json (gitignored — real reply text). Calls Jev only
 * when JEV_API_URL and JEV_API_KEY are set. Prints id-level scores, never
 * names or bodies.
 *
 * Usage:
 *   JEV_API_URL=... JEV_API_KEY=... node scripts/eval-jev-classifier.js
 */
const fs = require('fs');
const path = require('path');
const {
  classifyWithJev,
  isJevConfigured,
  missingJevEnv,
} = require('../src/services/jev-classifier');

const SAMPLE_CANDIDATES = [
  path.join(__dirname, '..', 'uploads', 'sample.json'),
  process.env.JEV_EVAL_SAMPLE || '',
].filter(Boolean);

// Acceptable category sets and whether the row is a pitch-to-us (1) or not (0).
const TRUTH = {
  1: [['OTHER', 'QUESTION'], 1],
  2: [['OTHER', 'QUESTION'], 1],
  3: [['QUESTION', 'INTERESTED'], 0],
  4: [['OTHER'], 1],
  5: [['INTERESTED'], 0],
  6: [['INTERESTED', 'OTHER'], 0],
  7: [['OTHER'], 1],
  8: [['OTHER'], 1],
  9: [['OTHER'], 1],
  10: [['QUESTION'], 0],
  11: [['OTHER'], 1],
  12: [['OTHER'], 1],
  13: [['INTERESTED'], 0],
  14: [['OTHER'], 1],
  15: [['OTHER'], 1],
  16: [['OTHER'], 1],
  17: [['OTHER'], 1],
  18: [['OTHER'], 1],
  19: [['OTHER', 'MEETING_PROPOSED'], 1],
  20: [['OTHER'], 1],
  21: [['REMOVE_ME'], 0],
  22: [['NOT_INTERESTED'], 0],
  23: [['WRONG_PERSON'], 0],
  24: [['OOO'], 0],
  25: [['WRONG_PERSON', 'NOT_INTERESTED'], 0],
  26: [['REMOVE_ME'], 0],
  27: [['NOT_INTERESTED'], 0],
  28: [['WRONG_PERSON'], 0],
  29: [['INTERESTED'], 0],
  30: [['NOT_INTERESTED'], 0],
  31: [['WRONG_PERSON'], 0],
  32: [['INTERESTED'], 0],
  33: [['QUESTION'], 0],
  34: [['MEETING_PROPOSED', 'INTERESTED'], 0],
  35: [['QUESTION', 'INTERESTED'], 0],
  36: [['INTERESTED'], 0],
  37: [['QUESTION'], 0],
  38: [['MEETING_PROPOSED'], 0],
  39: [['INTERESTED'], 0],
  40: [['OTHER'], 1],
  41: [['MEETING_PROPOSED'], 0],
  42: [['MEETING_PROPOSED'], 0],
  43: [['INTERESTED'], 0],
  44: [['INTERESTED'], 0],
  45: [['QUESTION'], 0],
  46: [['QUESTION'], 0],
  47: [['INTERESTED'], 0],
  48: [['QUESTION'], 0],
  49: [['QUESTION', 'OBJECTION'], 0],
  50: [['INTERESTED'], 0],
};

function loadSample() {
  for (const p of SAMPLE_CANDIDATES) {
    if (fs.existsSync(p)) {
      return { path: p, rows: JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
  }
  throw new Error('uploads/sample.json not found');
}

function hasCampaign(row) {
  const c = row.campaign;
  if (c == null) return false;
  const s = String(c).trim();
  return s && s !== '—' && s !== '-' && s !== '–';
}

function threadFor(row) {
  const msgs = [];
  if (row.sent) msgs.push({ role: 'us', message: String(row.sent) });
  msgs.push({ role: 'prospect', message: String(row.reply || '') });
  return msgs;
}

async function main() {
  if (!isJevConfigured()) {
    console.log(JSON.stringify({
      skipped: true,
      reason: `unset ${missingJevEnv().join(', ')}`,
    }, null, 2));
    process.exit(0);
  }

  const { path: samplePath, rows } = loadSample();
  const byId = new Map();
  for (const row of rows) byId.set(Number(row.id), row);

  const results = [];
  let jevRight = 0;
  let geminiRight = 0;
  let agree = 0;
  let cost = 0;
  const disagrees = [];
  const bothWrong = [];

  for (let id = 1; id <= 50; id += 1) {
    const row = byId.get(id);
    if (!row) throw new Error(`sample missing id ${id}`);
    const started = Date.now();
    const scored = await classifyWithJev(threadFor(row), row.reply);
    const secs = (Date.now() - started) / 1000;
    const choice = String(scored.classification || '').toUpperCase();
    const pitch = scored.pitchToUsProb;
    const okSet = new Set(TRUTH[id][0]);
    const okJ = okSet.has(choice);
    const okG = okSet.has(String(row.gemini || '').toUpperCase());
    if (okJ) jevRight += 1;
    if (okG) geminiRight += 1;
    if (choice === String(row.gemini || '').toUpperCase()) agree += 1;
    else disagrees.push({ id, gemini: row.gemini, jev: choice, gemini_ok: okG, jev_ok: okJ });
    if (!okJ && !okG) bothWrong.push({ id, jev: choice, gemini: row.gemini });
    cost += Number((scored.usage && scored.usage.cost) || 0);
    results.push({
      id,
      jev: choice,
      gemini: row.gemini,
      pitch: pitch,
      campaign: hasCampaign(row),
      ok_jev: okJ,
      ok_gemini: okG,
      is_pitch: TRUTH[id][1] === 1,
      secs,
    });
    process.stderr.write(`.`);
  }
  process.stderr.write('\n');

  function pitchStats(threshold, scope) {
    const rs = results.filter((r) => scope === 'all' || !r.campaign);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const fpIds = [];
    const fnIds = [];
    for (const r of rs) {
      const high = Number(r.pitch) >= threshold;
      if (high && r.is_pitch) tp += 1;
      else if (high && !r.is_pitch) {
        fp += 1;
        fpIds.push(r.id);
      } else if (!high && r.is_pitch) {
        fn += 1;
        fnIds.push({ id: r.id, pitch: r.pitch });
      }
    }
    return { threshold, scope, n: rs.length, tp, fp, fn, fpIds, fnIds };
  }

  const summary = {
    sample: path.basename(samplePath),
    n: results.length,
    jev_right: jevRight,
    gemini_right: geminiRight,
    agree,
    cost_usd: Math.round(cost * 1e5) / 1e5,
    disagrees,
    both_wrong: bothWrong,
    pitch: [
      pitchStats(0.5, 'all'),
      pitchStats(0.8, 'all'),
      pitchStats(0.8, 'nocamp'),
      pitchStats(0.95, 'nocamp'),
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
