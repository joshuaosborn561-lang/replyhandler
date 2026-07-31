const { getValidAccessToken } = require('./gmail-send');

/**
 * Read-only Drive access for the Cube ACR call-recording folder.
 *
 * Cube ACR writes one subfolder per date, and names each file after the phone
 * number it called. So a recording is found by searching for the number and
 * confirming the file sits somewhere under the configured root folder — which
 * avoids walking every date folder.
 *
 * Uses the primary Gmail OAuth token (drive.readonly scope). An account
 * connected before that scope was added must reconnect at /auth/gmail/connect.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const AUDIO_EXT = /\.(mp3|m4a|aac|amr|wav|ogg|opus|3gp|mp4)$/i;

function rootFolderId() {
  return String(process.env.CUBE_ACR_DRIVE_FOLDER_ID || '').trim();
}

function isConfigured() {
  return Boolean(rootFolderId());
}

/** Last 10 digits — the stable part across +1 / 1 / bare formats. */
function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

async function driveFetch(path, params = {}, { raw = false } = {}) {
  const { token } = await getValidAccessToken();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') qs.set(k, String(v));
  }
  const res = await fetch(`${DRIVE_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && /insufficient|scope/i.test(body)) {
      throw new Error(`Drive ${res.status}: reconnect at /auth/gmail/connect to grant drive.readonly`);
    }
    throw new Error(`Drive ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** Walk parents up to the root folder. Cached per call batch. */
async function isUnderRoot(fileId, cache = new Map()) {
  const root = rootFolderId();
  if (!root) return false;

  let current = fileId;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === root) return true;
    if (cache.has(current)) {
      current = cache.get(current);
    } else {
      let meta;
      try {
        meta = await driveFetch(`/files/${current}`, { fields: 'id,parents' });
      } catch {
        return false;
      }
      const parent = Array.isArray(meta?.parents) ? meta.parents[0] : null;
      cache.set(current, parent);
      current = parent;
    }
    if (!current) return false;
  }
  return false;
}

/**
 * Recordings for one phone number, newest first.
 * @returns {Promise<Array<{id,name,modifiedTime,mimeType,size}>>}
 */
async function findRecordingsForPhone(phone, { since } = {}) {
  if (!isConfigured()) return [];
  const key = phoneKey(phone);
  if (!key) return [];

  const clauses = [`name contains '${key}'`, 'trashed = false'];
  if (since) {
    const iso = since instanceof Date ? since.toISOString() : new Date(since).toISOString();
    clauses.push(`modifiedTime > '${iso}'`);
  }

  const data = await driveFetch('/files', {
    q: clauses.join(' and '),
    fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
    orderBy: 'modifiedTime desc',
    pageSize: 25,
    spaces: 'drive',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });

  const files = Array.isArray(data?.files) ? data.files : [];
  const candidates = files.filter(
    (f) => AUDIO_EXT.test(f.name || '') || String(f.mimeType || '').startsWith('audio/')
  );

  const cache = new Map();
  const out = [];
  for (const f of candidates) {
    const parent = Array.isArray(f.parents) ? f.parents[0] : null;
    if (!parent) continue;
    if (await isUnderRoot(parent, cache)) out.push(f);
  }
  return out;
}

/** Download file bytes. Returns null when it exceeds maxBytes. */
async function downloadFile(fileId, { maxBytes = 18 * 1024 * 1024 } = {}) {
  const meta = await driveFetch(`/files/${fileId}`, { fields: 'id,name,size,mimeType' });
  const size = parseInt(meta?.size || '0', 10);
  if (Number.isFinite(size) && size > maxBytes) {
    console.warn('[Drive] Recording too large to transcribe — skipping', { fileId, name: meta.name, size });
    return null;
  }
  const buf = await driveFetch(`/files/${fileId}`, { alt: 'media', supportsAllDrives: 'true' }, { raw: true });
  return { buffer: buf, mimeType: meta?.mimeType || 'audio/mpeg', name: meta?.name || fileId };
}

module.exports = {
  isConfigured,
  findRecordingsForPhone,
  downloadFile,
  phoneKey,
  rootFolderId,
};
