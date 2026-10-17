/**
 * Anonymized FOLLOW_UP threads modeled on real failures: the cadence bump
 * ignored an explicit prospect ask. No live lead or business names.
 */

function t(day, hour = 14) {
  return new Date(Date.UTC(2026, 8, day, hour, 0, 0)).toISOString();
}

const fixtures = [
  {
    id: 'info-first',
    title: 'Asked for details before any meeting',
    prospectAsk: 'Can you send the details first before we pick a time?',
    leadName: 'Alex Rivera',
    step: 1,
    daysSinceLastMessage: 1,
    threadMessages: [
      { role: 'us', time: t(2), body: 'Hey Alex, we help local service companies book more commercial work. Open to a quick intro later this week?' },
      { role: 'them', time: t(3), body: 'Maybe. What does this actually look like?' },
      { role: 'us', time: t(3, 16), body: 'Happy to walk through it live. Tuesday mid-morning or Wednesday early afternoon work?' },
      { role: 'them', time: t(4), body: 'Can you send the details first before we pick a time?' },
    ],
    lastInboundMessage: 'Can you send the details first before we pick a time?',
    lastOutboundMessage: 'Happy to walk through it live. Tuesday mid-morning or Wednesday early afternoon work?',
  },
  {
    id: 'send-it-over',
    title: 'Said send it over',
    prospectAsk: 'Yes send it over',
    leadName: 'Jordan Lee',
    step: 1,
    daysSinceLastMessage: 0.5,
    threadMessages: [
      { role: 'us', time: t(8), body: 'Hey Jordan, I can send a one-pager on how the outbound program works if useful.' },
      { role: 'them', time: t(8, 18), body: 'Yes send it over' },
    ],
    lastInboundMessage: 'Yes send it over',
    lastOutboundMessage: 'Hey Jordan, I can send a one-pager on how the outbound program works if useful.',
  },
  {
    id: 'tickets-email',
    title: 'Gave an email for tickets',
    prospectAsk: 'Send the tickets to alex@example.com',
    leadName: 'Sam Patel',
    step: 2,
    daysSinceLastMessage: 1,
    threadMessages: [
      { role: 'us', time: t(10), body: 'Sam, happy to send a couple tickets just for the convo if you want to meet.' },
      { role: 'them', time: t(11), body: 'Send the tickets to alex@example.com' },
      { role: 'us', time: t(11, 17), body: 'Got it, I will get those over.' },
    ],
    lastInboundMessage: 'Send the tickets to alex@example.com',
    lastOutboundMessage: 'Got it, I will get those over.',
  },
  {
    id: 'direct-question',
    title: 'Asked a direct qualification question',
    prospectAsk: "What's your minimum EBITDA?",
    leadName: 'Riley Chen',
    step: 1,
    daysSinceLastMessage: 1,
    threadMessages: [
      { role: 'us', time: t(12), body: 'Riley, we usually work with owners in that size range. Worth a short call this week?' },
      { role: 'them', time: t(13), body: "What's your minimum EBITDA?" },
    ],
    lastInboundMessage: "What's your minimum EBITDA?",
    lastOutboundMessage: 'Riley, we usually work with owners in that size range. Worth a short call this week?',
  },
  {
    id: 'different-need',
    title: 'Named a different need than the original offer',
    prospectAsk: 'We do not need more leads. We need help with hiring techs.',
    leadName: 'Casey Brooks',
    step: 2,
    daysSinceLastMessage: 2,
    threadMessages: [
      { role: 'us', time: t(1), body: 'Casey, I was offering a free campaign to get you more business clients.' },
      { role: 'them', time: t(2), body: 'We do not need more leads. We need help with hiring techs.' },
      { role: 'us', time: t(2, 16), body: 'Fair enough. Happy to talk through that instead if useful.' },
    ],
    lastInboundMessage: 'We do not need more leads. We need help with hiring techs.',
    lastOutboundMessage: 'Fair enough. Happy to talk through that instead if useful.',
  },
];

module.exports = { fixtures };
