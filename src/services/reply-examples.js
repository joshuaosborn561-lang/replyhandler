/**
 * Supabase-backed retrieval corpus for Josh's genuine manual replies.
 *
 * Embeddings use the current Gemini embedding model. text-embedding-004 was
 * retired in January 2026, so gemini-embedding-001 is requested at 768 dims.
 */

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY && process.env.GEMINI_API_KEY);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseRequest(path, { method = 'GET', body, headers } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  }
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: supabaseHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${String(text).slice(0, 400)}`);
  }
  return data;
}

function l2Normalize(values) {
  const nums = (values || []).map(Number);
  const norm = Math.sqrt(nums.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return nums;
  return nums.map((value) => value / norm);
}

async function embedText(text, taskType = 'RETRIEVAL_QUERY') {
  const input = String(text || '').trim();
  if (!input) throw new Error('Cannot embed empty text');
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const model = String(EMBEDDING_MODEL).replace(/^models\//, '');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:embedContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: input.slice(0, 24000) }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  });
  const responseText = await res.text();
  let data;
  try { data = JSON.parse(responseText); } catch { data = {}; }
  if (!res.ok) {
    throw new Error(`Gemini embedding failed (${res.status}): ${responseText.slice(0, 400)}`);
  }
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Gemini embedding returned ${values?.length || 0} dimensions, expected 768`);
  }
  // gemini-embedding-001 requires normalization for truncated vectors.
  return l2Normalize(values);
}

async function matchReplies(inboundMessage, matchCount = 4) {
  if (!isConfigured()) return [];
  const embedding = await embedText(inboundMessage, 'RETRIEVAL_QUERY');
  const data = await supabaseRequest('/rest/v1/rpc/match_replies', {
    method: 'POST',
    body: {
      query_embedding: embedding,
      match_count: matchCount,
    },
  });
  return Array.isArray(data) ? data : [];
}

async function insertReplyExample({
  sourceMessageId,
  pendingReplyId,
  leadMessage,
  myReply,
  threadContext,
  category,
  clientName,
  vertical,
  platform,
  sequenceNumber = null,
}) {
  if (!isConfigured()) return { skipped: 'not_configured' };
  if (sequenceNumber !== null && sequenceNumber !== undefined) {
    return { skipped: 'automated_sequence' };
  }
  const inbound = String(leadMessage || '').trim();
  const outbound = String(myReply || '').trim();
  if (!inbound || !outbound) return { skipped: 'missing_pair' };

  const embedding = await embedText(inbound, 'RETRIEVAL_DOCUMENT');
  const row = {
    source_message_id: sourceMessageId || null,
    pending_reply_id: pendingReplyId || null,
    lead_message: inbound,
    my_reply: outbound,
    thread_context: threadContext || null,
    category: category || null,
    client_name: clientName || null,
    vertical: vertical || null,
    platform: platform || null,
    sequence_number: null,
    embedding,
  };

  const conflict = sourceMessageId
    ? 'source_message_id'
    : pendingReplyId
      ? 'pending_reply_id'
      : '';
  const suffix = conflict ? `?on_conflict=${encodeURIComponent(conflict)}` : '';
  const data = await supabaseRequest(`/rest/v1/reply_examples${suffix}`, {
    method: 'POST',
    headers: {
      Prefer: conflict
        ? 'resolution=merge-duplicates,return=representation'
        : 'return=representation',
    },
    body: row,
  });
  return { inserted: true, row: Array.isArray(data) ? data[0] : data };
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  isConfigured,
  embedText,
  matchReplies,
  insertReplyExample,
  supabaseRequest,
  l2Normalize,
};
