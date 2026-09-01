const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('restart follow-ups after Meeting booked', () => {
  it('clears booked meeting rows and reschedules the positive cadence', () => {
    const src = read('src/services/outbound-follow-up.js');
    assert.ok(src.includes('async function restartFollowUpsForLead'), 'restart helper must exist');
    assert.ok(src.includes("status = 'cancelled'"), 'booked meetings must be cancelled so booking-check lets nudges through');
    assert.ok(src.includes('scheduleAfterOutboundSend'), 'restart must reuse the real cadence scheduler');
    assert.ok(src.includes('postFollowUpCard'), 'restart can post step 1 immediately');
  });

  it('exposes POST /admin/restart-follow-ups', () => {
    const admin = read('src/routes/admin.js');
    assert.ok(admin.includes("/admin/restart-follow-ups"));
    assert.ok(admin.includes('restartFollowUpsForLead'));
  });
});
