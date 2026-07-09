#!/usr/bin/env node
/**
 * Export Slack-approved sent replies for Gemini voice training.
 *
 * Usage:
 *   node scripts/export-slack-sent-for-voice.js
 *   node scripts/export-slack-sent-for-voice.js --client Nieto
 *   node scripts/export-slack-sent-for-voice.js --sync-voice
 *
 * Env:
 *   BASE_URL  production app URL (default: https://app-production-9354.up.railway.app)
 *   OUT_DIR   output directory (default: ./training-exports)
 */

const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE_URL || 'https://app-production-9354.up.railway.app').replace(/\/$/, '');
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'training-exports');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) return null;
  return process.argv[i + 1];
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function resolveClientId(nameNeedle) {
  if (!nameNeedle) return null;
  const clients = await fetchJson(`${BASE}/admin/clients`);
  const match = clients.find((c) => String(c.name).toLowerCase().includes(nameNeedle.toLowerCase()));
  if (!match) throw new Error(`No client matching "${nameNeedle}"`);
  return match.id;
}

async function main() {
  const clientNeedle = argValue('--client');
  const syncVoice = process.argv.includes('--sync-voice');
  const clientId = await resolveClientId(clientNeedle);

  if (syncVoice) {
    const body = clientId ? { clientId } : {};
    const result = await fetchJson(`${BASE}/admin/voice-training/sync-voice-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('[Voice] Synced voice_prompt from Slack sends:', JSON.stringify(result, null, 2));
  }

  const qs = new URLSearchParams({ limit: '200' });
  if (clientId) qs.set('clientId', clientId);

  const data = await fetchJson(`${BASE}/admin/voice-training/sent-replies?${qs}`);
  const pairs = data.pairs || [];
  console.log(`[Voice] Slack-sent training pairs: ${pairs.length}`);

  if (!pairs.length) {
    console.log('No Slack-approved sends in DB yet. Approve replies in Slack to build training data.');
    console.log('You can also run: node scripts/export-manual-replies-for-training.js (SmartLead/HeyReach outbound)');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const prefix = clientNeedle ? clientNeedle.toLowerCase().replace(/\s+/g, '-') : 'all-clients';

  const jsonPath = path.join(OUT_DIR, `slack-sent-${prefix}-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  console.log('Wrote', jsonPath);

  const jsonl = await fetch(`${BASE}/admin/voice-training/sent-replies.jsonl?${qs}`).then((r) => r.text());
  const jsonlPath = path.join(OUT_DIR, `slack-sent-${prefix}-${stamp}.jsonl`);
  fs.writeFileSync(jsonlPath, jsonl);
  console.log('Wrote', jsonlPath);

  if (data.voicePromptPreview) {
    const promptPath = path.join(OUT_DIR, `voice-prompt-${prefix}-${stamp}.txt`);
    fs.writeFileSync(promptPath, data.voicePromptPreview);
    console.log('Wrote', promptPath);
  }

  console.log('\nSample pairs:');
  for (const p of pairs.slice(0, 5)) {
    console.log(`\n— ${p.clientName} / ${p.leadName} (${p.platform})${p.wasEdited ? ' [edited]' : ''}`);
    console.log('  Prospect:', String(p.inboundMessage || '').slice(0, 100).replace(/\s+/g, ' '));
    console.log('  Sent:    ', String(p.outboundReply || '').slice(0, 120).replace(/\s+/g, ' '));
  }

  const audit = await fetchJson(`${BASE}/admin/booking-links/audit`);
  console.log('\nBooking links:');
  for (const c of audit.clients.filter((x) => x.active)) {
    console.log(`  ${c.hasBookingLink ? '✓' : '✗'} ${c.name}: ${c.bookingLink || 'MISSING'}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
