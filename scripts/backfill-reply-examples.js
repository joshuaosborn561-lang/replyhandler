#!/usr/bin/env node
/**
 * Backfill genuine manual SmartLead replies from Supabase.
 *
 * Structural rule (never phrase-based):
 *   direction = 'outbound' AND sequence_number IS NULL
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
 *     node scripts/backfill-reply-examples.js
 */

const { insertReplyExample } = require('../src/services/reply-examples');

const BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PAGE_SIZE = 1000;

function headers(extra = {}) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function getRows(table, query = '') {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const separator = query ? '&' : '';
    const url =
      `${BASE}/rest/v1/${table}?${query}${separator}` +
      `limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers: headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Supabase ${table} fetch failed (${res.status}): ${text.slice(0, 400)}`);
    }
    const page = JSON.parse(text);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function getRowsOptional(table, query = '') {
  try {
    return await getRows(table, query);
  } catch (err) {
    console.warn(`[Backfill] Optional ${table} lookup skipped: ${err.message}`);
    return [];
  }
}

async function getRowsByIds(table, ids, select = '*') {
  const rows = [];
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  for (let index = 0; index < unique.length; index += 100) {
    const batch = unique.slice(index, index + 100);
    const query =
      `select=${encodeURIComponent(select)}` +
      `&id=in.(${batch.map(encodeURIComponent).join(',')})`;
    rows.push(...await getRowsOptional(table, query));
  }
  return rows;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function threadKey(message) {
  return `${message.campaign_id ?? ''}|${message.lead_id ?? ''}`;
}

function idKey(value) {
  return value == null ? '' : String(value);
}

function campaignName(row) {
  return row?.client_name || row?.client || row?.account_name || row?.name || null;
}

function campaignVertical(row) {
  return row?.vertical || row?.industry || row?.niche || null;
}

function categoryFromRow(row) {
  return row?.category || row?.category_name || row?.name || row?.label || null;
}

async function main() {
  if (!BASE || !KEY || !process.env.GEMINI_API_KEY) {
    throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and GEMINI_API_KEY are required');
  }

  // Pull all messages once so "preceding inbound" is calculated by structure
  // and time rather than by brittle copy matching.
  const messages = await getRows(
    'messages',
    'select=id,body,subject,direction,sequence_number,lead_id,campaign_id,sent_at&order=sent_at.asc'
  );
  const outbound = messages.filter((m) => String(m.direction).toLowerCase() === 'outbound');
  const manual = outbound.filter(
    (m) => m.sequence_number === null || m.sequence_number === undefined
  );

  console.log('[Backfill] Counts', {
    totalMessages: messages.length,
    totalOutbound: outbound.length,
    qualifyingManualOutbound: manual.length,
    automatedSequenceOutbound: outbound.length - manual.length,
  });

  const campaigns = await getRowsOptional('campaigns', 'select=*');
  // Do not download the full (60k+) leads table. Join only the leads represented
  // by the 166-ish qualifying manual messages.
  const leads = await getRowsByIds(
    'leads',
    manual.map((message) => message.lead_id),
    'id,campaign_id,vertical,category,category_id,client_name'
  );
  const categories = await getRowsOptional('lead_categories', 'select=*');

  const campaignMap = new Map(
    campaigns.map((row) => [idKey(row.id || row.campaign_id), row])
  );
  const leadMap = new Map(
    leads.map((row) => [idKey(row.id || row.lead_id), row])
  );
  const categoryMap = new Map(
    categories.map((row) => [idKey(row.id), categoryFromRow(row)])
  );

  const threads = new Map();
  for (const message of messages) {
    const key = threadKey(message);
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(message);
  }

  let inserted = 0;
  let skippedNoInbound = 0;
  let failed = 0;

  for (const reply of manual) {
    const thread = threads.get(threadKey(reply)) || [];
    const replyIndex = thread.findIndex((message) => idKey(message.id) === idKey(reply.id));
    const before = replyIndex >= 0 ? thread.slice(0, replyIndex) : [];
    const inbound = [...before].reverse().find(
      (message) => String(message.direction).toLowerCase() === 'inbound'
    );
    if (!inbound) {
      skippedNoInbound += 1;
      continue;
    }

    const leadMessage = stripHtml(inbound.body);
    const myReply = stripHtml(reply.body);
    if (!leadMessage || !myReply) {
      skippedNoInbound += 1;
      continue;
    }

    const contextRows = before.slice(-6).map((message) => ({
      direction: message.direction,
      sent_at: message.sent_at,
      body: stripHtml(message.body),
    }));
    const campaign = campaignMap.get(idKey(reply.campaign_id)) || {};
    const lead = leadMap.get(idKey(reply.lead_id)) || {};
    const category =
      lead.category ||
      categoryMap.get(idKey(lead.category_id)) ||
      lead.category_name ||
      null;

    try {
      await insertReplyExample({
        sourceMessageId: idKey(reply.id),
        leadMessage,
        myReply,
        threadContext: JSON.stringify(contextRows),
        category,
        clientName: campaignName(campaign),
        vertical: campaignVertical(campaign) || lead.vertical || lead.industry || null,
        platform: 'smartlead',
        sequenceNumber: null,
      });
      inserted += 1;
      if (inserted % 20 === 0) {
        console.log(`[Backfill] Embedded/upserted ${inserted}/${manual.length}`);
      }
    } catch (err) {
      failed += 1;
      console.error('[Backfill] Row failed', {
        messageId: reply.id,
        leadId: reply.lead_id,
        err: err.message,
      });
    }
  }

  console.log('[Backfill] Complete', {
    totalOutbound: outbound.length,
    qualifyingManualOutbound: manual.length,
    insertedOrUpdated: inserted,
    skippedNoInbound,
    failed,
  });
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[Backfill] Fatal:', err.message);
  process.exit(1);
});
