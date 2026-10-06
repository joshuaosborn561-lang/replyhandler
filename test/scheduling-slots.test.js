const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickOpenStarts,
  pickTwoBusinessDayStarts,
  parseCalendlyPublicUrl,
  slotOffsetForFollowUpStep,
  timesPlusLinkPromptBlock,
  schedulingPromptBookingLinkOnly,
} = require('../src/services/scheduling-slots');

describe('scheduling slot picks', () => {
  const starts = [
    new Date('2026-10-06T15:00:00.000Z'),
    new Date('2026-10-06T15:30:00.000Z'),
    new Date('2026-10-07T15:00:00.000Z'),
    new Date('2026-10-07T15:30:00.000Z'),
    new Date('2026-10-08T15:00:00.000Z'),
    new Date('2026-10-08T15:30:00.000Z'),
  ];

  it('first reply takes the first two open starts', () => {
    const picked = pickOpenStarts(starts, { offset: 0, count: 2 });
    assert.equal(picked.length, 2);
    assert.equal(picked[0].toISOString(), starts[0].toISOString());
    assert.equal(picked[1].toISOString(), starts[1].toISOString());
  });

  it('next-day follow-up skips the first two offered starts', () => {
    assert.equal(slotOffsetForFollowUpStep(2), 2);
    const picked = pickOpenStarts(starts, { offset: slotOffsetForFollowUpStep(2), count: 2 });
    assert.equal(picked[0].toISOString(), starts[2].toISOString());
    assert.equal(picked[1].toISOString(), starts[3].toISOString());
  });

  it('excludeStarts drops previously offered times before offset', () => {
    const picked = pickOpenStarts(starts, {
      offset: 0,
      count: 2,
      excludeStarts: [starts[0], starts[1]],
    });
    assert.equal(picked[0].toISOString(), starts[2].toISOString());
    assert.equal(picked[1].toISOString(), starts[3].toISOString());
  });

  it('prompt tells the model to paste the booking URL with the two times', () => {
    const block = timesPlusLinkPromptBlock({
      slots: [
        { start: starts[0].toISOString(), label: 'Tue, Oct 6, 11:00 AM EDT' },
        { start: starts[1].toISOString(), label: 'Tue, Oct 6, 11:30 AM EDT' },
      ],
      link: 'https://calendly.com/example/30min',
      inPerson: false,
    });
    assert.match(block, /TIMES \+ BOOKING LINK/);
    assert.match(block, /calendly.com\/example\/30min/);
    assert.doesNotMatch(block, /Do NOT paste/);
  });

  it('in-person prompt never includes a booking URL', () => {
    const block = timesPlusLinkPromptBlock({
      slots: [
        { start: starts[0].toISOString(), label: 'Tue, Oct 6, 11:00 AM EDT' },
        { start: starts[1].toISOString(), label: 'Tue, Oct 6, 11:30 AM EDT' },
      ],
      link: 'https://calendly.com/example/30min',
      inPerson: true,
    });
    assert.match(block, /IN-PERSON/);
    assert.doesNotMatch(block, /calendly.com\/example\/30min/);
  });

  it('poller skip-fetch prompt still includes the booking URL', () => {
    const { promptBlock } = schedulingPromptBookingLinkOnly({
      name: 'SalesGlider',
      booking_link: 'https://calendly.com/example/30min',
    });
    assert.match(promptBlock, /TIMES \+ BOOKING LINK/);
    assert.match(promptBlock, /calendly.com\/example\/30min/);
  });

  it('weekday mid-morning is a business slot; Saturday is not', () => {
    const { isLocalBusinessSlot } = require('../src/services/scheduling-slots');
    assert.equal(
      isLocalBusinessSlot(new Date('2026-10-06T15:00:00.000Z'), 'America/New_York'),
      true
    );
    assert.equal(
      isLocalBusinessSlot(new Date('2026-10-10T15:00:00.000Z'), 'America/New_York'),
      false
    );
  });

  it('no-slots copy does not ask for a Calendly PAT or client OAuth', () => {
    const block = timesPlusLinkPromptBlock({
      slots: [],
      link: 'https://book.gosalesglider.com/parlay',
      inPerson: false,
    });
    assert.match(block, /public booking page/);
    assert.doesNotMatch(block, /PAT|Google\/Outlook/);
  });

  it('parses a public Calendly /profile/event URL', () => {
    assert.deepEqual(
      parseCalendlyPublicUrl('https://calendly.com/joshua-salesglidergrowth/30min'),
      { profileSlug: 'joshua-salesglidergrowth', eventTypeSlug: '30min' }
    );
  });

  it('parses HubSpot Meetings and MS Bookings public URLs', () => {
    const {
      parseHubSpotPublicUrl,
      parseMsBookingsPublicUrl,
    } = require('../src/services/scheduling-slots');
    assert.deepEqual(
      parseHubSpotPublicUrl('https://meetings.hubspot.com/dave-ackley'),
      { host: 'meetings.hubspot.com', slug: 'dave-ackley' }
    );
    const ms = parseMsBookingsPublicUrl(
      'https://bookings.cloud.microsoft/bookwithme/user/7faa90d1324a4bc6a511427c5b9a1488%40culture-fits.com/meetingtype/vkqrp6uGEUq_wrB0u0dyhA2?anonymous'
    );
    assert.equal(ms.user, '7faa90d1324a4bc6a511427c5b9a1488@culture-fits.com');
    assert.equal(ms.meetingType, 'vkqrp6uGEUq_wrB0u0dyhA2');
  });

  it('reads SavvyCal linkId from the public inertia page', () => {
    const { parseSavvyCalInertiaPage } = require('../src/services/scheduling-slots');
    const html = `
      <script data-page="app" type="application/json">
        {"props":{"linkId":"link_01ABC","organizer":{"user":{"id":"user_01XYZ"}}}}
      </script>
    `;
    assert.deepEqual(parseSavvyCalInertiaPage(html), {
      linkId: 'link_01ABC',
      organizerId: 'user_01XYZ',
    });
  });

  it('picks tomorrow and the next business day, never the same day', () => {
    const tz = 'America/Chicago';
    const now = new Date('2026-10-05T23:00:00.000Z'); // Mon evening CT
    const tue = new Date('2026-10-06T15:30:00.000Z'); // Tue 10:30 CT
    const tueLater = new Date('2026-10-06T16:30:00.000Z');
    const wed = new Date('2026-10-07T15:30:00.000Z');
    const thu = new Date('2026-10-08T15:30:00.000Z');
    const picked = pickTwoBusinessDayStarts([tue, tueLater, wed, thu], {
      timeZone: tz, offset: 0, count: 2, now,
    });
    assert.equal(picked.length, 2);
    assert.equal(picked[0].toISOString(), tue.toISOString());
    assert.equal(picked[1].toISOString(), wed.toISOString());
  });

  it('Friday rolls across the weekend to Monday and Tuesday', () => {
    const tz = 'America/Chicago';
    const now = new Date('2026-10-09T22:00:00.000Z'); // Friday evening CT
    const fri = new Date('2026-10-09T15:30:00.000Z');
    const sat = new Date('2026-10-10T15:30:00.000Z');
    const sun = new Date('2026-10-11T15:30:00.000Z');
    const mon = new Date('2026-10-12T15:30:00.000Z');
    const tue = new Date('2026-10-13T15:30:00.000Z');
    const picked = pickTwoBusinessDayStarts([fri, sat, sun, mon, tue], { timeZone: tz, now });
    assert.deepEqual(
      picked.map((d) => d.toISOString()),
      [mon.toISOString(), tue.toISOString()]
    );
  });
});

const fs = require('node:fs');
const path = require('node:path');

describe('public booking page is checked — no PAT, no client OAuth', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/scheduling-slots.js'), 'utf8');

  it('skipExternalFetch still hits the public booking page', () => {
    const resolve = src.slice(src.indexOf('async function resolveVerifiedSchedulingSlots'));
    assert.match(resolve, /skipExternalFetch/);
    assert.match(resolve, /fetchPublicBookingStarts/);
    assert.match(resolve, /resolveLiveAvailabilityBookingUrl/);
    assert.ok(
      resolve.indexOf('fetchPublicBookingStarts') < resolve.indexOf('schedulingPromptBookingLinkOnly'),
      'public page check must run before the no-lookup fallback'
    );
  });

  it('does not require a Calendly PAT to pick times', () => {
    const resolve = src.slice(src.indexOf('async function resolveVerifiedSchedulingSlots'));
    assert.doesNotMatch(resolve, /calendly_personal_access_token/);
  });
});

describe('public booking dispatch', () => {
  it('reads HubSpot availability-page startMillisUtc', async () => {
    const { fetchPublicHubSpotStarts } = require('../src/services/scheduling-slots');
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.match(String(url), /meetings-public\/v3\/book\/availability-page/);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          linkAvailability: {
            hasMore: false,
            linkAvailabilityByDuration: {
              1800000: {
                meetingDurationMillis: 1800000,
                availabilities: [
                  { startMillisUtc: Date.parse('2026-10-07T15:00:00.000Z') },
                  { startMillisUtc: Date.parse('2026-10-08T15:00:00.000Z') },
                ],
              },
            },
          },
        }),
      };
    };
    try {
      const pub = await fetchPublicHubSpotStarts('https://meetings.hubspot.com/dave-ackley');
      assert.equal(pub.starts.length, 2);
      assert.equal(pub.starts[0].toISOString(), '2026-10-07T15:00:00.000Z');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('dispatches HubSpot and Calendly from the destination host', async () => {
    const { fetchPublicBookingStarts } = require('../src/services/scheduling-slots');
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('calendly.com/api/booking/event_types/lookup')) {
        return {
          ok: true,
          json: async () => ({ uuid: 'et-1', availability_timezone: 'America/Chicago' }),
        };
      }
      if (String(url).includes('calendar/range')) {
        return {
          ok: true,
          json: async () => ({
            days: [{ spots: [{ status: 'available', start_time: '2026-10-07T15:30:00.000Z' }] }],
          }),
        };
      }
      if (String(url).includes('availability-page')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            linkAvailability: {
              hasMore: false,
              linkAvailabilityByDuration: {
                1800000: {
                  availabilities: [{ startMillisUtc: Date.parse('2026-10-07T16:00:00.000Z') }],
                },
              },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const cal = await fetchPublicBookingStarts('https://calendly.com/joshua-salesglidergrowth/30min');
      const hs = await fetchPublicBookingStarts('https://meetings.hubspot.com/dave-ackley');
      assert.equal(cal.starts[0].toISOString(), '2026-10-07T15:30:00.000Z');
      assert.equal(hs.starts[0].toISOString(), '2026-10-07T16:00:00.000Z');
    } finally {
      global.fetch = originalFetch;
    }
    assert.ok(seen.some((u) => u.includes('calendly.com')));
    assert.ok(seen.some((u) => u.includes('hubspot.com')));
  });
});
