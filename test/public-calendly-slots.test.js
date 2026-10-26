const test = require('node:test');
const assert = require('node:assert');
const { parseBridgeClientsJs, pickTwoAcrossDays } = require('../src/services/scheduling-slots');

test('parses BookingBridge clients.js booking URLs by slug', () => {
  const src = `window.CLIENTS = {\n  "vector": {\n    name: "Vector Energy Group",\n    bookingUrl: "https://calendly.com/agancman-vectorenergygroup/new-meeting",\n    accent: "#1a1a1a",\n  },\n  parlay: { name: 'Parlay', bookingUrl: 'https://calendly.com/x/y' },\n};`;
  const m = parseBridgeClientsJs(src);
  assert.strictEqual(m.vector, 'https://calendly.com/agancman-vectorenergygroup/new-meeting');
  assert.strictEqual(m.parlay, 'https://calendly.com/x/y');
});

test('picks first open slot on two different days', () => {
  const s = ['2026-10-26T18:00:00Z', '2026-10-26T18:30:00Z', '2026-10-27T18:00:00Z'].map((x) => new Date(x));
  const two = pickTwoAcrossDays(s, 'America/Chicago');
  assert.deepStrictEqual(two.map((d) => d.toISOString()), ['2026-10-26T18:00:00.000Z', '2026-10-27T18:00:00.000Z']);
});
