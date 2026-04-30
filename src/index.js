const path = require('path');
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const slackRoutes = require('./routes/slack');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const testWebhookRoutes = require('./routes/test-webhooks');
const { startCron } = require('./cron');
const { assertDatabaseReady, getHealthStatus } = require('./db-ready');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Body parsing ────────────────────────────────────────────────────
// Capture raw body for Slack signature verification
app.use('/slack', express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// JSON for everything else
// SmartLead webhooks can include large HTML reply bodies (signatures/quoted threads).
// Raise limit so we don't 413 and "miss" replies.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));

// ─── Dashboard UI ────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ─── Health check (fails with 503 if schema or active clients missing — Railway should not route traffic) ───
app.get('/health', async (_req, res) => {
  try {
    const body = await getHealthStatus();
    res.json(body);
  } catch (err) {
    console.error('[Health] Unhealthy:', err.message);
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ─── Routes ──────────────────────────────────────────────────────────
app.use(webhookRoutes);
app.use(slackRoutes);
app.use(adminRoutes);
app.use(authRoutes);
app.use(testWebhookRoutes);

// ─── Start ───────────────────────────────────────────────────────────
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

start();
