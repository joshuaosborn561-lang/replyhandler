const path = require('path');
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const slackRoutes = require('./routes/slack');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const testWebhookRoutes = require('./routes/test-webhooks');
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

// ─── Dashboard UI ────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Routes ──────────────────────────────────────────────────────────
app.use(webhookRoutes);
app.use(slackRoutes);
app.use(adminRoutes);
app.use(authRoutes);
app.use(testWebhookRoutes);

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ReplyHandler running on port ${PORT}`);
  startCron();
});
