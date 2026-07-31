const allo = require('./allo');
const drive = require('./google-drive');

/**
 * One-shot probe at boot: prove the call-recording integrations actually work,
 * rather than finding out hours later when a follow-up needs them.
 *
 * Logs the Allo lines on the account and whether Drive is readable. Never
 * throws — a failed probe is a log line, not a failed start.
 */
let lastStatus = { at: null, allo: 'unknown', drive: 'unknown' };

function getIntegrationStatus() {
  return { ...lastStatus };
}

async function logIntegrationStatus() {
  lastStatus = { at: new Date().toISOString(), allo: 'unknown', drive: 'unknown' };

  if (!allo.isConfigured()) {
    lastStatus.allo = 'not_configured';
    console.log('[Startup] Allo not configured (ALLO_API_KEY unset) — call booking checks skipped');
  } else {
    try {
      const numbers = await allo.alloNumbers();
      if (numbers.length) {
        lastStatus.allo = 'ready';
        lastStatus.alloNumberCount = numbers.length;
        console.log('[Startup] Allo ready', { numbers, count: numbers.length });
      } else {
        lastStatus.allo = 'no_numbers';
        console.warn('[Startup] Allo key works but no numbers returned — check the account has a line');
      }
    } catch (err) {
      lastStatus.allo = `error: ${err.message}`;
      console.error('[Startup] Allo check failed', { err: err.message });
    }
  }

  if (!drive.isConfigured()) {
    lastStatus.drive = 'not_configured';
    console.log('[Startup] Cube ACR not configured (CUBE_ACR_DRIVE_FOLDER_ID unset) — recording checks skipped');
    return getIntegrationStatus();
  }
  try {
    // A number that matches nothing still exercises auth, scope and the folder.
    await drive.findRecordingsForPhone('0000000000');
    lastStatus.drive = 'ready';
    console.log('[Startup] Drive ready', { folderId: drive.rootFolderId() });
  } catch (err) {
    lastStatus.drive = `error: ${err.message}`;
    console.error('[Startup] Drive check failed — reconnect at /auth/gmail/connect if this mentions scope', {
      err: err.message,
    });
  }
  return getIntegrationStatus();
}

module.exports = { logIntegrationStatus, getIntegrationStatus };
