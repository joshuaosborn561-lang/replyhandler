-- Decode HTML entities already stored on recent inbound replies.
--
-- The SmartLead inbox poller was persisting bodies like
-- "Bill Hall &#8211; Project Executive" while the webhook stored the decoded
-- dash. Dedupe compares a 120-character prefix, and those two forms diverged
-- inside it (Bill Hall, EMCOR, 2026-10-22), so the same reply posted twice.
--
-- New writes decode before insert. This pass rewrites rows the poller already
-- saved so a later redelivery matches, and so the card does not show the
-- entity. Only the last 30 days: the poller lookback is 7 days, and older
-- history is left untouched. Rows with no entity are not rewritten.
-- Idempotent: a second run finds nothing to change.
--
-- The helper is dropped at the end. Comparison does not call it — JS and
-- STORED_NORM_SQL fold entities and dashes themselves, so a missed row still
-- dedupes. Named entities here must stay in sync with NAMED_HTML_ENTITIES in
-- src/utils/html-entities.js.

CREATE OR REPLACE FUNCTION replyhandler_decode_html_entities_040(src text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  cur text := src;
  prev text;
  pass int := 0;
  guard int;
  m text[];
  code int;
  hex text;
  i int;
  ch text;
BEGIN
  IF cur IS NULL OR cur = '' OR position('&' IN cur) = 0 THEN
    RETURN src;
  END IF;

  WHILE pass < 3 LOOP
    prev := cur;

    cur := regexp_replace(cur, '&amp;', '&', 'gi');
    cur := regexp_replace(cur, '&lt;', '<', 'gi');
    cur := regexp_replace(cur, '&gt;', '>', 'gi');
    cur := regexp_replace(cur, '&quot;', '"', 'gi');
    cur := regexp_replace(cur, '&apos;', '''', 'gi');
    cur := regexp_replace(cur, '&nbsp;', chr(160), 'gi');
    cur := regexp_replace(cur, '&ensp;', chr(8194), 'gi');
    cur := regexp_replace(cur, '&emsp;', chr(8195), 'gi');
    cur := regexp_replace(cur, '&thinsp;', chr(8201), 'gi');
    cur := regexp_replace(cur, '&ndash;', chr(8211), 'gi');
    cur := regexp_replace(cur, '&mdash;', chr(8212), 'gi');
    cur := regexp_replace(cur, '&minus;', chr(8722), 'gi');
    cur := regexp_replace(cur, '&hyphen;', chr(8208), 'gi');
    cur := regexp_replace(cur, '&lsquo;', chr(8216), 'gi');
    cur := regexp_replace(cur, '&rsquo;', chr(8217), 'gi');
    cur := regexp_replace(cur, '&sbquo;', chr(8218), 'gi');
    cur := regexp_replace(cur, '&ldquo;', chr(8220), 'gi');
    cur := regexp_replace(cur, '&rdquo;', chr(8221), 'gi');
    cur := regexp_replace(cur, '&bdquo;', chr(8222), 'gi');
    cur := regexp_replace(cur, '&hellip;', chr(8230), 'gi');
    cur := regexp_replace(cur, '&bull;', chr(8226), 'gi');
    cur := regexp_replace(cur, '&laquo;', chr(171), 'gi');
    cur := regexp_replace(cur, '&raquo;', chr(187), 'gi');

    guard := 0;
    WHILE cur ~ '&#[0-9]{1,7};' AND guard < 100 LOOP
      m := regexp_match(cur, '&#([0-9]{1,7});');
      EXIT WHEN m IS NULL;
      code := m[1]::int;
      IF code < 1 OR code > 1114111 OR (code >= 55296 AND code <= 57343) THEN
        cur := replace(cur, '&#' || m[1] || ';', '');
      ELSE
        BEGIN
          ch := chr(code);
        EXCEPTION WHEN OTHERS THEN
          ch := '';
        END;
        cur := replace(cur, '&#' || m[1] || ';', ch);
      END IF;
      guard := guard + 1;
    END LOOP;

    guard := 0;
    WHILE cur ~ '&#[xX][0-9A-Fa-f]{1,6};' AND guard < 100 LOOP
      -- Capture the whole token so replace() stays literal. A regex
      -- replacement would treat chr(92) ('\') as an escape.
      m := regexp_match(cur, '(&#[xX][0-9A-Fa-f]{1,6};)');
      EXIT WHEN m IS NULL;
      hex := lower(substring(m[1] from 4 for length(m[1]) - 4));
      code := 0;
      FOR i IN 1..length(hex) LOOP
        code := code * 16 + position(substr(hex, i, 1) IN '0123456789abcdef') - 1;
      END LOOP;
      IF code < 1 OR code > 1114111 OR (code >= 55296 AND code <= 57343) THEN
        ch := '';
      ELSE
        BEGIN
          ch := chr(code);
        EXCEPTION WHEN OTHERS THEN
          ch := '';
        END;
      END IF;
      cur := replace(cur, m[1], ch);
      guard := guard + 1;
    END LOOP;

    pass := pass + 1;
    EXIT WHEN cur IS NOT DISTINCT FROM prev;
  END LOOP;

  RETURN cur;
END;
$fn$;

UPDATE pending_replies
   SET inbound_message = replyhandler_decode_html_entities_040(inbound_message)
 WHERE created_at > now() - interval '30 days'
   AND inbound_message ~ '&(#([0-9]{1,7}|[xX][0-9A-Fa-f]{1,6})|[A-Za-z][A-Za-z0-9]{1,31});'
   AND inbound_message IS DISTINCT FROM replyhandler_decode_html_entities_040(inbound_message);

DROP FUNCTION replyhandler_decode_html_entities_040(text);

-- Stats-id backup lookup: same client, platform, stats id, campaign, and a
-- created_at range. Migration 008 indexes smartlead_email_stats_id alone.
-- That index does not cover campaign_id or the time bound, and a COALESCE
-- around the column cannot use it. This one matches the bare equalities in
-- sameStatsWindowSql (client_id, platform, stats id, campaign_id, then the
-- created_at range).
CREATE INDEX IF NOT EXISTS idx_pending_replies_stats_dedupe
  ON pending_replies (client_id, platform, smartlead_email_stats_id, campaign_id, created_at);
