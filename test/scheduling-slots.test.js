const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickOpenStarts,
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
});
