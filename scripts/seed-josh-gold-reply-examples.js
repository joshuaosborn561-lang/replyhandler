#!/usr/bin/env node
/**
 * Seed SalesGlider gold ack-first pairs into Supabase reply_examples.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... \
 *     node scripts/seed-josh-gold-reply-examples.js [--dry-run]
 */
const replyExamples = require('../src/services/reply-examples');

const DRY = process.argv.includes('--dry-run');

const GOLD = [
  {
    category: 'QUESTION',
    leadMessage: "Hi Joshua,\nWhat's the catch?\nThanks,\nScott",
    myReply:
      "Hey Scott, just gave you a ring. No catch...trying to provide some value on the front end for you. I know your inbox is full of this kind of stuff...time Monday morning or Tuesday to connect?",
  },
  {
    category: 'QUESTION',
    leadMessage: 'What other staffing in Jupiter do u work with?',
    myReply:
      "Hey Max, thanks for getting back to me. Sorry for the confusion- none in Jupiter, meant to say we can serve clients in Jupiter...but funny enough I live in Jupiter on Center St for a while (in Dallas now very small world!)",
  },
  {
    category: 'QUESTION',
    leadMessage:
      "I would love to think what you are saying is realistic, but I have heard this a million times. Big promises with lackluster delivery. How are you different?",
    myReply:
      "Hey Brian, thanks for getting back to me. Fair enough...just gave you a ring. Figure it would be easiest to talk for 2 minutes and then see if it makes sense to move forward.\n\nLong story short: I come from sales myself and have closed over 25m. My clients have actually closed business from our services. Happy to explain why most of the stuff out there is AI crap now if you have a few minutes.",
  },
  {
    category: 'QUESTION',
    leadMessage:
      "Before scheduling time, could you send over a brief case study showing the client's target audience, how many contacts were reached, how many of the 41 replies were qualified opportunities?",
    myReply:
      "Hey Tom, thanks for getting back to me.\n\nSo for the 41 replies, all of them were within the ICP (commercial owners or property managers.) They did DQ some based on industry, so that left around 24 qualified opportunities.\n\nRevenue is not something we track...as you can imagine there are factors outside of our control. But anecdotally, a client just told me he closed 100k off a meeting we booked for him :)\n\nHope that gives you a better picture. Open to grabbing some time tomorrow or Thursday?",
  },
  {
    category: 'OTHER',
    leadMessage:
      'I am located down in Franklin, TN. Although I do love Brewers games when I am back in Madison.',
    myReply:
      "Hey Jonathon, thanks for getting back to me, sorry for the mixup!\n\nIs adding more business clients something that's relevant to you?\n\nStill happy to get you tickets when you're back in WI.",
  },
  {
    category: 'OTHER',
    leadMessage: "I would be interested in that what's the cost per lead?",
    myReply:
      "Ok great! Most of my clients actually prefer a straight monthly cost, but I could do a per lead if you prefer. Would be around $300.\n\nIf you're up for it I have 15 minutes right now actually...or we can chat later, here's my booking link.",
  },
  {
    category: 'INTERESTED',
    leadMessage: 'We have run a email campaign before with little results.',
    myReply:
      "Hey Jim, thanks for getting back to me. We've helped a lot of people who have run into that exact problem in the past. Happy to jump on a quick call and walk through how we're different. Does Tuesday mid-morning or Wednesday early afternoon work for a quick call with me? If neither works I can send a booking link.",
  },
  {
    category: 'INTERESTED',
    leadMessage: 'Sure',
    myReply:
      "Hey Dean, thanks for getting back to me, sounds good!\n\nI have some time to connect before 11 CST to see if this makes sense to explore further? Or I can send you my calendar link if that is better.",
  },
  {
    category: 'INTERESTED',
    leadMessage: 'Love the giant tix idea!',
    myReply:
      "Hey Erik, thanks for getting back to me — glad the tickets landed. Happy to jump on a quick call and walk through it. Does Thursday or Friday late afternoon work for a quick call with me? If neither works I can send a booking link.",
  },
  {
    category: 'MEETING_PROPOSED',
    leadMessage: 'Can we do a meeting from 1-3?',
    myReply:
      "Hey Chase, appreciate you throwing times over. I'm a bit tight 1-3 this week — are you able to do 4 pm EST any day this week?",
  },
];

async function main() {
  if (!replyExamples.isConfigured()) {
    console.error('Supabase/Gemini not configured — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY');
    process.exit(1);
  }
  console.log(`Seeding ${GOLD.length} Josh gold examples${DRY ? ' (dry-run)' : ''}...`);
  for (const [i, g] of GOLD.entries()) {
    console.log(`  ${i + 1}. [${g.category}] ${g.leadMessage.slice(0, 60).replace(/\n/g, ' ')}…`);
    if (DRY) continue;
    const result = await replyExamples.insertReplyExample({
      sourceMessageId: `josh-gold-${i + 1}-${g.category.toLowerCase()}`,
      leadMessage: g.leadMessage,
      myReply: g.myReply,
      category: g.category,
      clientName: 'SalesGlider',
      platform: 'smartlead',
      sequenceNumber: null,
    });
    console.log('     →', result.skipped || (result.inserted ? 'inserted' : 'ok'));
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
