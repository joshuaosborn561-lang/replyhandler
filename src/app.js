const path = require('path');
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const bookingBridgeRecapRoutes = require('./routes/booking-bridge-recap');
const meetstreamRoutes = require('./routes/meetstream');
const slackRoutes = require('./routes/slack');
const adminRoutes = require('./routes/admin');
const dashboardApiRoutes = require('./routes/dashboard-api');
const clientActionRoutes = require('./routes/client-action');
const authRoutes = require('./routes/auth');
const testWebhookRoutes = require('./routes/test-webhooks');
const voiceLearningRoutes = require('./routes/voice-learning');
const onboardingRoutes = require('./routes/onboarding');
const publicBookingCatalogRoutes = require('./routes/public-booking-catalog');

function createApp() {
  const app = express();

  // Capture raw body for Slack signature verification
  app.use('/slack', express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
  }));

  // SmartLead webhooks can include large HTML reply bodies (signatures/quoted threads).
  // Raise limit so we don't 413 and "miss" replies.
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));

  // Open dashboard — no login, no ADMIN_API_KEY on read.
  app.use('/dashboard', express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => res.redirect('/dashboard'));
  app.use(dashboardApiRoutes);
  // Public, read-only booking catalog. Must mount before routers that call
  app.use(publicBookingCatalogRoutes);

  app.get('/health', async (_req, res) => {
    try {
      const { getHealthStatus } = require('./db-ready');
      const body = await getHealthStatus();
      res.json(body);
    } catch (err) {
      console.error('[Health] Unhealthy:', err.message);
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.use(webhookRoutes);
  app.use(bookingBridgeRecapRoutes);
  app.use(meetstreamRoutes);
  app.use(slackRoutes);
  app.use(onboardingRoutes);
  app.use(adminRoutes);
  app.use(clientActionRoutes);
  app.use(authRoutes);
  app.use(testWebhookRoutes);
  app.use(voiceLearningRoutes);

  return app;
}

module.exports = { createApp };
