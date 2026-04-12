#!/usr/bin/env node
/**
 * Post a fake approval card to Slack (same blocks as production) without Gemini.
 *
 * Usage:
 *   export WEBHOOK_TEST_SECRET='your-secret'
 *   export CLIENT_ID='<uuid from dashboard /admin/clients>'
 *   export BASE_URL='http://localhost:3000'   # or your public URL
 *   node scripts/post-test-slack-draft.js
 *
 * SmartLead / HeyReach fake JSON bodies live in scripts/fake-webhook-payloads.json
 * for curl tests against /webhook/smartlead/:id and /webhook/heyreach/:id.
 */

const { readFileSync } = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const secret = process.env.WEBHOOK_TEST_SECRET;
const clientId = process.env.CLIENT_ID;

if (!secret || !clientId) {
  console.error('Set WEBHOOK_TEST_SECRET and CLIENT_ID environment variables.');
  process.exit(1);
}

async function main() {
  const fixturesPath = path.join(__dirname, 'fake-webhook-payloads.json');
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

  const res = await fetch(`${BASE_URL}/admin/test/slack-draft/${clientId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-test-secret': secret,
    },
    body: JSON.stringify({
      classification: 'MEETING_PROPOSED',
      reasoning: 'Fixture: prospect asked for times (not from Gemini).',
      inboundMessage: fixtures.smartlead_meeting.reply,
      leadName: fixtures.smartlead_meeting.name,
      leadEmail: fixtures.smartlead_meeting.email,
      platform: 'smartlead',
      draft:
        'Thanks, Jamie — Tuesday afternoon works. Would 2:00pm or 3:30pm ET Tuesday work for you? If it is easier, you can lock a time here: https://calendly.com/your-handle/30min',
    }),
  });

  const body = await res.text();
  console.log(res.status, body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
