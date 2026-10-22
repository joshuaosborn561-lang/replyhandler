/**
 * HTML entity decode and dash / quote folding for inbound reply text.
 *
 * SmartLead's webhook delivers a decoded body ("Bill Hall - Project
 * Executive") while the inbox poller keeps the source entities
 * ("Bill Hall &#8211; Project Executive"). Those strings diverge inside
 * the 120-character dedupe prefix (Bill Hall, EMCOR, 2026-10-22).
 * Decoding and folding happen before comparison. Storage keeps the
 * decoded characters (an en dash stays an en dash) so the card still
 * reads naturally; the fold is comparison-only.
 */

/** Named entities we actually see in SmartLead / Outlook HTML. */
const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  minus: '\u2212',
  hyphen: '\u2010',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201A',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bdquo: '\u201E',
  hellip: '\u2026',
  bull: '\u2022',
  laquo: '\u00AB',
  raquo: '\u00BB',
};

/** Dash-like characters that must compare equal to ASCII "-". */
const DASH_CODEPOINTS = [
  0x2010, // hyphen
  0x2011, // non-breaking hyphen
  0x2012, // figure dash
  0x2013, // en dash
  0x2014, // em dash
  0x2015, // horizontal bar
  0x2212, // minus
  0xFE58, // small em dash
  0xFE63, // small hyphen-minus
  0xFF0D, // fullwidth hyphen-minus
];

/** Curly / typographic single quotes → ASCII apostrophe. */
const SINGLE_QUOTE_CODEPOINTS = [
  0x2018, // ‘
  0x2019, // ’
  0x201A, // ‚
  0x201B, // ‛
  0x2032, // ′
];

/** Curly / typographic double quotes → ASCII quote. */
const DOUBLE_QUOTE_CODEPOINTS = [
  0x201C, // “
  0x201D, // ”
  0x201E, // „
  0x201F, // ‟
  0x00AB, // «
  0x00BB, // »
  0x2033, // ″
];

const NAMED_ENTITY_PATTERN = new RegExp(
  `&(${Object.keys(NAMED_HTML_ENTITIES).join('|')});`,
  'gi'
);

function codePointToChar(code) {
  if (!Number.isInteger(code) || code < 1 || code > 0x10FFFF) return null;
  if (code >= 0xD800 && code <= 0xDFFF) return null;
  return String.fromCodePoint(code);
}

/**
 * Decode numeric (decimal and hex) and known named HTML entities.
 * Repeats so `&amp;ndash;` and `&amp;#8211;` unwrap. Unknown names are
 * left intact. A bare `&` is not an entity.
 */
function decodeHtmlEntities(text) {
  let s = String(text || '');
  for (let pass = 0; pass < 3; pass++) {
    const next = s
      .replace(/&#(\d{1,7});/g, (match, dec) => {
        const ch = codePointToChar(Number(dec));
        return ch == null ? match : ch;
      })
      .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => {
        const ch = codePointToChar(parseInt(hex, 16));
        return ch == null ? match : ch;
      })
      .replace(NAMED_ENTITY_PATTERN, (match, name) => {
        const ch = NAMED_HTML_ENTITIES[String(name).toLowerCase()];
        return ch == null ? match : ch;
      });
    if (next === s) break;
    s = next;
  }
  return s;
}

function foldDashAndQuotes(text) {
  const dashes = new RegExp(`[${DASH_CODEPOINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`, 'g');
  const singles = new RegExp(`[${SINGLE_QUOTE_CODEPOINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`, 'g');
  const doubles = new RegExp(`[${DOUBLE_QUOTE_CODEPOINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`, 'g');
  return String(text || '')
    .replace(dashes, '-')
    .replace(singles, "'")
    .replace(doubles, '"');
}

/** What we persist. Decoded, original dashes and quotes preserved. */
function decodeInboundForStorage(text) {
  return decodeHtmlEntities(text);
}

module.exports = {
  NAMED_HTML_ENTITIES,
  DASH_CODEPOINTS,
  SINGLE_QUOTE_CODEPOINTS,
  DOUBLE_QUOTE_CODEPOINTS,
  decodeHtmlEntities,
  foldDashAndQuotes,
  decodeInboundForStorage,
};
