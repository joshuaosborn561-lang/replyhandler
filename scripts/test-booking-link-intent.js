#!/usr/bin/env node
/**
 * Quick assertions for times-first vs booking-link follow-up detection.
 * Run: node scripts/test-booking-link-intent.js
 */
const assert = require('assert');
const {
  looksLikeBookingLinkRequest,
  outboundOfferedToSendBookingLink,
  stripBookingUrls,
} = require('../src/utils/booking-link-intent');
const { sanitizeDraft, buildTimeSuggestionBlock } = require('../src/services/classifier');

const offeredThread = [
  { type: 'SENT', message: 'Can you do Thursday mid-morning or Friday early afternoon? If neither works I can send a booking link.' },
  { type: 'REPLY', message: 'Sure' },
];

assert.strictEqual(outboundOfferedToSendBookingLink(offeredThread), true);
assert.strictEqual(looksLikeBookingLinkRequest('Sure', offeredThread), true);
assert.strictEqual(looksLikeBookingLinkRequest('sure, send the link', offeredThread), true);
assert.strictEqual(looksLikeBookingLinkRequest('Neither work', offeredThread), true);
assert.strictEqual(looksLikeBookingLinkRequest('Please send the calendly', []), true);
assert.strictEqual(looksLikeBookingLinkRequest('Tell me more', offeredThread), false);
assert.strictEqual(looksLikeBookingLinkRequest('Sure', [{ type: 'SENT', message: 'Would love to connect sometime.' }]), false);

const link = 'https://calendly.com/ceo/30min';
assert.ok(!stripBookingUrls(`Hey — ${link}`, link).includes('calendly'));
assert.ok(sanitizeDraft(`Hey Tony, here's a time.\n\n${link}`, { bookingLink: link, includeBookingLink: false }).includes('calendly') === false);
assert.ok(sanitizeDraft('Sounds good.', { bookingLink: link, includeBookingLink: true }).includes(link));

const timesBlock = buildTimeSuggestionBlock({ includeBookingLink: false, digestTimezone: 'America/Chicago' });
assert.ok(/TIMES-FIRST/i.test(timesBlock));
assert.ok(!/include it once/i.test(timesBlock));

const linkBlock = buildTimeSuggestionBlock({ includeBookingLink: true });
assert.ok(/booking link/i.test(linkBlock));

console.log('ok — booking-link intent + sanitizeDraft');
