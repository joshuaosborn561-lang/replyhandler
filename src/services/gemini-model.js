'use strict';

/** Default Gemini model. Older 2.x names now 404 for our key. */
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** The one Gemini model setting for replyhandler (env GEMINI_MODEL). */
function geminiModel(env = process.env) {
  const raw = String(env.GEMINI_MODEL || '').trim();
  return raw || DEFAULT_GEMINI_MODEL;
}

module.exports = { DEFAULT_GEMINI_MODEL, geminiModel };
