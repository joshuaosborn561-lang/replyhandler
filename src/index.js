const { createApp } = require('./app');
const { startCron } = require('./cron');
const { assertDatabaseReady } = require('./db-ready');

const app = createApp();
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await assertDatabaseReady();
  } catch (err) {
    console.error('[Server] Database not ready:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[Server] ReplyHandler running on port ${PORT}`);
    startCron();
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, createApp, start };
