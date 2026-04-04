const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const slackRoutes = require('./routes/slack');
const adminRoutes = require('./routes/admin');
const { startCron } = require('./cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Body parsing ────────────────────────────────────────────────────
// Capture raw body for Slack signature verification
app.use('/slack', express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// JSON for everything else
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Routes ──────────────────────────────────────────────────────────
app.use(webhookRoutes);
app.use(slackRoutes);
app.use(adminRoutes);

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ReplyHandler running on port ${PORT}`);
  startCron();
});
