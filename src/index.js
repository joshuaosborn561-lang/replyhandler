const { createApp } = require('./app');
const { startCron } = require('./cron');
const { assertDatabaseReady } = require('./db-ready');
const { drainInFlightSends } = require('./services/send-inflight');

const app = createApp();
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await assertDatabaseReady();
  } catch (err) {
    console.error('[Server] Database not ready:', err.message);
    process.exit(1);
  }
  const server = app.listen(PORT, () => {
    console.log(`[Server] ReplyHandler running on port ${PORT}`);
    startCron();
  });
  installShutdown(server);
}

let shuttingDown = false;
function installShutdown(server) {
  process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[Server] SIGTERM — draining in-flight sends');
    const finish = () => {
      if (!server || typeof server.close !== 'function') {
        process.exit(0);
        return;
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref?.();
    };
    drainInFlightSends(25000).then((result) => {
      console.log('[Server] In-flight sends drained', result);
      finish();
    }).catch(() => finish());
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, createApp, start };
