/**
 * Fireflies GraphQL client for Josh's call transcripts.
 *
 * Auth is Bearer FIREFLIES_API_KEY against https://api.fireflies.ai/graphql.
 * Search by keyword (client name / domain) with scope=all so title and
 * sentences both match. Never required at boot — missing key is reported.
 */

const FIREFLIES_URL = process.env.FIREFLIES_API_URL || 'https://api.fireflies.ai/graphql';
const REQUIRED_ENV = 'FIREFLIES_API_KEY';

function apiKey(env = process.env) {
  return String(env.FIREFLIES_API_KEY || env.FIREFLIES_API_TOKEN || '').trim();
}

function isConfigured(env = process.env) {
  return Boolean(apiKey(env));
}

function requiredEnvVar() {
  return REQUIRED_ENV;
}

async function graphql(query, variables = {}, { fetchImpl = fetch, env = process.env } = {}) {
  const key = apiKey(env);
  if (!key) {
    const err = new Error(`${REQUIRED_ENV} is not set`);
    err.code = 'FIREFLIES_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetchImpl(FIREFLIES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Fireflies HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  if (body.errors && body.errors.length) {
    throw new Error(`Fireflies GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

const SEARCH_QUERY = `
  query SearchTranscripts($keyword: String!, $scope: String, $limit: Int) {
    transcripts(keyword: $keyword, scope: $scope, limit: $limit) {
      id
      title
      date
      host_email
      organizer_email
      participants
      meeting_attendees { displayName email name }
    }
  }
`;

const TRANSCRIPT_QUERY = `
  query Transcript($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      sentences { speaker_name text raw_text }
      summary { overview short_summary keywords }
      meeting_attendees { displayName email name }
      participants
    }
  }
`;

async function searchTranscripts(keyword, { limit = 20, fetchImpl, env } = {}) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const data = await graphql(SEARCH_QUERY, {
    keyword: q.slice(0, 256),
    scope: 'all',
    limit,
  }, { fetchImpl, env });
  return Array.isArray(data?.transcripts) ? data.transcripts.filter((t) => t?.id) : [];
}

async function getTranscript(id, { fetchImpl, env } = {}) {
  const data = await graphql(TRANSCRIPT_QUERY, { id: String(id) }, { fetchImpl, env });
  return data?.transcript || null;
}

const WINDOW_QUERY = `
  query TranscriptsBetween($from: DateTime, $to: DateTime, $limit: Int) {
    transcripts(fromDate: $from, toDate: $to, limit: $limit) {
      id
      title
      date
      duration
      is_live
      organizer_email
      participants
      meeting_attendees { displayName email name }
      meeting_info { silent_meeting summary_status }
      meeting_attendance { name join_time leave_time }
    }
  }
`;

const ATTENDANCE_QUERY = `
  query TranscriptAttendance($id: String!) {
    transcript(id: $id) {
      id
      date
      sentences { speaker_name text }
      speakers { id name }
      meeting_info { silent_meeting summary_status }
      meeting_attendance { name join_time leave_time }
      meeting_attendees { displayName email name }
      participants
    }
  }
`;

/** Transcripts created inside [from, to] (Date objects). Fireflies caps one page at 50. */
async function listTranscriptsBetween(from, to, { limit = 50, fetchImpl, env } = {}) {
  const data = await graphql(WINDOW_QUERY, {
    from: from.toISOString(), to: to.toISOString(), limit: Math.min(50, limit),
  }, { fetchImpl, env });
  return Array.isArray(data?.transcripts) ? data.transcripts.filter((t) => t?.id) : [];
}

/** Who spoke / joined, for deciding whether the prospect was really on the call. */
async function getTranscriptAttendance(id, { fetchImpl, env } = {}) {
  const data = await graphql(ATTENDANCE_QUERY, { id: String(id) }, { fetchImpl, env });
  return data?.transcript || null;
}

function attendeeBlob(row) {
  const people = [
    ...(Array.isArray(row?.meeting_attendees) ? row.meeting_attendees : []),
  ];
  const names = people.map((p) => [p?.displayName, p?.name, p?.email].filter(Boolean).join(' '));
  const extras = [
    row?.title,
    row?.host_email,
    row?.organizer_email,
    Array.isArray(row?.participants) ? row.participants.join(' ') : row?.participants,
  ];
  return [...names, ...extras].filter(Boolean).join(' ').toLowerCase();
}

function transcriptMatches(row, { name, domains = [] } = {}) {
  const blob = attendeeBlob(row);
  if (!blob) return false;
  const tokens = String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (tokens.length && tokens.every((t) => blob.includes(t))) return true;
  if (tokens.some((t) => t.length >= 5 && blob.includes(t))) return true;
  for (const domain of domains) {
    const d = String(domain || '').toLowerCase().replace(/^www\./, '');
    if (d && blob.includes(d)) return true;
  }
  return false;
}

function sentencesToText(row) {
  const sentences = Array.isArray(row?.sentences) ? row.sentences : [];
  const lines = sentences.map((s) => {
    const who = s?.speaker_name ? `${s.speaker_name}: ` : '';
    return who + String(s?.text || s?.raw_text || '').trim();
  }).filter((line) => line.replace(/^[^:]+:\s*/, ''));
  const summary = row?.summary?.overview || row?.summary?.short_summary || '';
  return [summary, ...lines].filter(Boolean).join('\n');
}

module.exports = {
  REQUIRED_ENV,
  requiredEnvVar,
  apiKey,
  isConfigured,
  graphql,
  searchTranscripts,
  getTranscript,
  listTranscriptsBetween,
  getTranscriptAttendance,
  transcriptMatches,
  sentencesToText,
  attendeeBlob,
};
