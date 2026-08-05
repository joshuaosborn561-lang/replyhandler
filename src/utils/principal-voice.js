/**
 * Some clients (SalesGlider / InsightSpeak) are drafted as the founder/CEO
 * in first person. Others hand off to "our CEO". Driven by voice_prompt.
 */

function speaksAsPrincipal(voicePrompt) {
  const s = String(voicePrompt || '').toLowerCase();
  if (!s.trim()) return false;
  if (/\bi am the ceo\b/.test(s)) return true;
  if (/\byou are the ceo\b/.test(s)) return true;
  if (/\bspeak as (the )?ceo\b/.test(s)) return true;
  if (/\bfirst[- ]person\b/.test(s) && /\bceo\b/.test(s)) return true;
  if (/\bnever say ['"]?our ceo\b/.test(s)) return true;
  if (/\byou are (joshua|josh)\b/.test(s) && /\bceo\b/.test(s)) return true;
  return false;
}

/** Call framing for times-first asks. */
function callWithWhom(voicePrompt) {
  return speaksAsPrincipal(voicePrompt) ? 'me' : 'our CEO';
}

module.exports = { speaksAsPrincipal, callWithWhom };
