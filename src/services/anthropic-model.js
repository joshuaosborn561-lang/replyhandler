'use strict';

/**
 * The one Claude Sonnet setting for replyhandler (env ANTHROPIC_REPLY_MODEL).
 * Josh (Oct 2026): "reply handlers should be using Sonnet, not Flash."
 * Gemini stays as the fallback when Anthropic errors.
 */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

function anthropicModel(env = process.env) {
  const raw = String(env.ANTHROPIC_REPLY_MODEL || '').trim();
  return raw || DEFAULT_ANTHROPIC_MODEL;
}

module.exports = { DEFAULT_ANTHROPIC_MODEL, anthropicModel };
