const crypto = require('crypto');

function slackVerify(req, res, next) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    console.error('[Slack] SLACK_SIGNING_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (!timestamp || !signature) {
    return res.status(400).json({ error: 'Missing Slack signature headers' });
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) {
    return res.status(400).json({ error: 'Request too old' });
  }

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  const expected = `v0=${hmac}`;

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  next();
}

module.exports = slackVerify;
