-- One follow-up card per cadence step, and one in-flight send per card.
--
-- Overlapping runner ticks (a second replica, or a run that outlasts the cron
-- interval) both used to see status = 'pending' and each post a Slack card.
-- Approve then only looked for an already-sent copy of the same text, so both
-- cards could send. `posting` / `sending` are the claims. The unique indexes
-- are the durable dedupe key.
--
-- Applied on startup by scripts/run-migrations.js (039). 037 and 038 were
-- already used for draft_variant and lead location.

ALTER TABLE outbound_follow_ups
  DROP CONSTRAINT IF EXISTS outbound_follow_ups_status_check;

ALTER TABLE outbound_follow_ups
  ADD CONSTRAINT outbound_follow_ups_status_check
  CHECK (status IN ('pending', 'posting', 'notified', 'cancelled', 'skipped'));

ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_status_check
  CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent', 'flagged',
    'alert_only', 'suppressed', 'disqualified', 'meeting_booked',
    'sending', 'skipped'
  ));

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS follow_up_id UUID,
  ADD COLUMN IF NOT EXISTS follow_up_step INTEGER,
  ADD COLUMN IF NOT EXISTS follow_up_source_id UUID;

-- Keep one open/notified row per step. Prefer a row that already posted.
WITH ranked_email AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY
             client_id,
             platform,
             COALESCE(campaign_id, ''),
             lower(lead_email),
             COALESCE(conversation_id, ''),
             step,
             COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY
             CASE status WHEN 'notified' THEN 0 WHEN 'posting' THEN 1 ELSE 2 END,
             created_at ASC
         ) AS rn
    FROM outbound_follow_ups
   WHERE status IN ('pending', 'posting', 'notified')
     AND lead_email IS NOT NULL AND lead_email <> ''
)
UPDATE outbound_follow_ups f
   SET status = 'cancelled',
       skip_reason = 'duplicate_step',
       updated_at = now()
  FROM ranked_email r
 WHERE f.id = r.id
   AND r.rn > 1;

WITH ranked_lead AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY
             client_id,
             platform,
             COALESCE(campaign_id, ''),
             lead_id,
             COALESCE(conversation_id, ''),
             step,
             COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY
             CASE status WHEN 'notified' THEN 0 WHEN 'posting' THEN 1 ELSE 2 END,
             created_at ASC
         ) AS rn
    FROM outbound_follow_ups
   WHERE status IN ('pending', 'posting', 'notified')
     AND lead_id IS NOT NULL AND lead_id <> ''
)
UPDATE outbound_follow_ups f
   SET status = 'cancelled',
       skip_reason = 'duplicate_step',
       updated_at = now()
  FROM ranked_lead r
 WHERE f.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_replies_one_follow_up_card
  ON pending_replies (follow_up_id)
  WHERE follow_up_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_follow_ups_step_by_email
  ON outbound_follow_ups (
    client_id,
    platform,
    COALESCE(campaign_id, ''),
    lower(lead_email),
    COALESCE(conversation_id, ''),
    step,
    COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('pending', 'posting', 'notified')
    AND lead_email IS NOT NULL AND lead_email <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_follow_ups_step_by_lead
  ON outbound_follow_ups (
    client_id,
    platform,
    COALESCE(campaign_id, ''),
    lead_id,
    COALESCE(conversation_id, ''),
    step,
    COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('pending', 'posting', 'notified')
    AND lead_id IS NOT NULL AND lead_id <> '';
