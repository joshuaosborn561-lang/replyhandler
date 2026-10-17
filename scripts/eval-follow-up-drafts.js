#!/usr/bin/env node
/**
 * Eyeball FOLLOW_UP drafts against the anonymized fixtures.
 * Requires ANTHROPIC_API_KEY in the environment. RAG is optional.
 *
 *   node scripts/eval-follow-up-drafts.js
 */
const { fixtures } = require('../test/fixtures/follow-up-threads');
const {
  generateFollowUpClaudeDraft,
  anthropicKeyConfigured,
} = require('../src/services/claude-reply-draft');

async function main() {
  if (!anthropicKeyConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set — cannot generate live drafts.');
    process.exit(2);
  }

  const out = [];
  for (const fx of fixtures) {
    process.stderr.write(`Generating ${fx.id}...\n`);
    try {
      const result = await generateFollowUpClaudeDraft({
        leadName: fx.leadName,
        lastInboundMessage: fx.lastInboundMessage,
        lastOutboundMessage: fx.lastOutboundMessage,
        threadMessages: fx.threadMessages,
        step: fx.step,
        daysSinceLastMessage: fx.daysSinceLastMessage,
        platform: 'smartlead',
        bookingLink: 'https://book.example.test/intro',
        slots: [
          { label: 'Tue, Oct 7, 10:00 AM CDT' },
          { label: 'Wed, Oct 8, 2:00 PM CDT' },
        ],
        founderName: 'Taylor',
        voicePrompt: 'Write as our SDR. Taylor is the founder. Loop Taylor in for decks and one-pagers.',
      });
      out.push({
        id: fx.id,
        title: fx.title,
        prospectAsk: fx.prospectAsk,
        draft: result.text,
        needs_client: result.needsClient === true,
        what_to_send: result.whatToSend,
        model: result.model,
        usage: result.usage,
      });
    } catch (err) {
      out.push({
        id: fx.id,
        title: fx.title,
        prospectAsk: fx.prospectAsk,
        error: err.message,
      });
    }
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
