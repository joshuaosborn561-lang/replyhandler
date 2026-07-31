const allo = require('./allo');
const drive = require('./google-drive');

/**
 * One-shot probe at boot: prove the call-recording integrations actually work,
 * rather than finding out hours later when a follow-up needs them.
 *
 * Logs the Allo lines on the account and whether Drive is readable. Never
 * throws — a failed probe is a log line, not a failed start.
 */
async function logIntegrationStatus() {
  if (!allo.isConfigured()) {
    console.log('[Startup] Allo not configured (ALLO_API_KEY unset) — call booking checks skipped');
  } else {
    try {
      const numbers = await allo.alloNumbers();
      if (numbers.length) {
        console.log('[Startup] Allo ready', { numbers, count: numbers.length });
      } else {
        console.warn('[Startup] Allo key works but no numbers returned — check the account has a line');
      }
    } catch (err) {
      console.error('[Startup] Allo check failed', { err: err.message });
    }
  }

  if (!drive.isConfigured()) {
    console.log('[Startup] Cube ACR not configured (CUBE_ACR_DRIVE_FOLDER_ID unset) — recording checks skipped');
    return;
  }
  try {
    // A number that matches nothing still exercises auth, scope and the folder.
    await drive.findRecordingsForPhone('0000000000');
    console.log('[Startup] Drive ready', { folderId: drive.rootFolderId() });
  } catch (err) {
    console.error('[Startup] Drive check failed — reconnect at /auth/gmail/connect if this mentions scope', {
      err: err.message,
    });
  }
}

module.exports = { logIntegrationStatus };
