const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  deepRootsClientNotifySkipReason,
  shouldNotifyDeepRootsClient,
  wantsToScheduleCall,
  EBITDA_MIN_USD,
  EBITDA_MAX_USD,
  EMPLOYEE_MIN,
} = require('../src/utils/deep-roots-client-notify');

const deep = { clientName: 'Deep Roots' };

function hist(pairs) {
  return pairs.map(([side, body]) => ({
    type: side === 'us' ? 'SENT' : 'REPLY',
    email_body: body,
  }));
}

describe('Deep Roots client notify gate', () => {
  it('does not gate other clients', () => {
    assert.equal(deepRootsClientNotifySkipReason({
      clientName: 'PowerGryd',
      inboundMessage: 'How did you get my email?',
      classification: 'QUESTION',
    }), null);
    assert.equal(shouldNotifyDeepRootsClient({
      clientName: 'Roofs by Peterson',
      inboundMessage: 'Sure',
      classification: 'INTERESTED',
    }), true);
  });

  it('skips Ken-style EBITDA questions with no schedule and no confirm', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'What is your minimum EBITA.',
      classification: 'QUESTION',
      threadContext: hist([
        ['us', 'Ken, Gabriel with Deep Roots Capital here. we typically go after 1-10m EBITDA.'],
        ['prospect', 'What is your minimum EBITA.'],
      ]),
    });
    assert.equal(reason, 'not_scheduling');
  });

  it('skips Neel: wants a call but skirted EBITDA', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'Tomorrow works!',
      classification: 'MEETING_PROPOSED',
      threadContext: hist([
        ['us', "Hey Neel, we're looking at businesses with $1M to $10M in EBITDA. Does sound like you?"],
        ['prospect', 'What will you require ?'],
        ['us', 'What time works best for you? Tyler will give you a call from 218-469-3457.'],
        ['prospect', 'Tomorrow works!'],
      ]),
    });
    assert.equal(reason, 'ebitda_unconfirmed');
  });

  it('skips Jason open-to-selling with no time and no size confirm', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'im open to selling',
      classification: 'INTERESTED',
      threadContext: hist([
        ['us', "I'm interested in purchasing Cohort Craft Brewery. worth a conversation?"],
        ['prospect', 'SOLD!'],
        ['us', 'Hey Jason does that mean you sold the company or that you wanted to chat haha.'],
        ['prospect', 'im open to selling'],
      ]),
    });
    assert.equal(reason, 'not_scheduling');
  });

  it('notifies when they confirmed EBITDA earlier and later pick a time', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'Tuesday 2pm works.',
      classification: 'MEETING_PROPOSED',
      threadContext: hist([
        ['us', "We're looking at businesses with $1M to $10M in EBITDA. Does that sound like you?"],
        ['prospect', 'Yes that sounds like us.'],
        ['us', 'What time works best for you? Tyler will give you a call from 218-469-3457.'],
        ['prospect', 'Tuesday 2pm works.'],
      ]),
    });
    assert.equal(reason, null);
  });

  it('does not treat a later yes about ownership as EBITDA confirm', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'Yes, we are! Tomorrow works.',
      classification: 'MEETING_PROPOSED',
      threadContext: hist([
        ['us', "We're looking at businesses with $1M to $10M in EBITDA. Does sound like you?"],
        ['prospect', 'What will you require ?'],
        ['us', 'I also wanted to confirm, you own GGChem, correct?'],
        ['prospect', 'Yes, we are! Tomorrow works.'],
      ]),
    });
    assert.equal(reason, 'ebitda_unconfirmed');
  });

  it('notifies when they confirm the $1-10M range and want a time', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'Yes that sounds like us. Tuesday 2pm works.',
      classification: 'MEETING_PROPOSED',
      threadContext: hist([
        ['us', "We're looking at businesses with $1M to $10M in EBITDA. Does that sound like you?"],
        ['prospect', 'Yes that sounds like us. Tuesday 2pm works.'],
      ]),
    });
    assert.equal(reason, null);
  });

  it('notifies when they state in-range EBITDA + a day that works', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'We do about $3M EBITDA. Tomorrow works.',
      classification: 'INTERESTED',
    });
    assert.equal(reason, null);
  });

  it('skips stated EBITDA below $1M even if they want a call', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'We do about $200k EBITDA. Tuesday morning works.',
      classification: 'MEETING_PROPOSED',
    });
    assert.equal(reason, 'ebitda_out_of_range');
  });

  it('skips a too-small shop when they name headcount', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'Yes we are in that 1-10m EBITDA range, 3 employees. Thursday 10am works.',
      classification: 'MEETING_PROPOSED',
      threadContext: hist([
        ['us', '$1M to $10M in EBITDA. Does that sound like you?'],
        ['prospect', 'Yes we are in that 1-10m EBITDA range, 3 employees. Thursday 10am works.'],
      ]),
    });
    assert.equal(reason, 'employees_out_of_range');
  });

  it('does not treat our outbound $1-10M copy as their confirmation', () => {
    const reason = deepRootsClientNotifySkipReason({
      ...deep,
      inboundMessage: 'How did you obtain my reference?',
      classification: 'QUESTION',
      threadContext: hist([
        ['us', 'We go after owner run manufacturers, usually businesses doing $1M to $10M in EBITDA. worth a quick call?'],
        ['prospect', 'How did you obtain my reference?'],
      ]),
    });
    assert.equal(reason, 'not_scheduling');
  });

  it('tomorrow works counts as scheduling interest', () => {
    assert.equal(wantsToScheduleCall('Tomorrow works!', 'QUESTION'), true);
    assert.equal(wantsToScheduleCall('What is your minimum EBITA.', 'QUESTION'), false);
    assert.equal(wantsToScheduleCall('im open to selling', 'INTERESTED'), false);
    assert.equal(wantsToScheduleCall('call me next week', 'INTERESTED'), true);
  });

  it('exports the published bars', () => {
    assert.equal(EBITDA_MIN_USD, 1_000_000);
    assert.equal(EBITDA_MAX_USD, 10_000_000);
    assert.equal(EMPLOYEE_MIN, 10);
  });
});

