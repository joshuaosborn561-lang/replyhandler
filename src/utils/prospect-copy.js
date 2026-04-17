/**
 * Client asked for no em dash (U+2014) or en dash (U+2013) in prospect-facing copy.
 * Normalize model output and fallbacks to hyphens / short pauses.
 */
function normalizeProspectCopy(text) {
  if (text == null || text === '') return text;
  return String(text)
    .replace(/\u2013/g, '-') // en dash -> hyphen
    .replace(/\u2014/g, ' - ') // em dash -> spaced hyphen
    .replace(/[ \t]{2,}/g, ' ') // do not collapse newlines (email bodies)
    .trim();
}

module.exports = { normalizeProspectCopy };
