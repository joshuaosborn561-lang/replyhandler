-- Client positive-reply roll-up (Josh, Oct 29): an approved, sent reply to a positive prospect is queued
-- here instead of emailing the client at once; the weekday 4:00pm CT job sends ONE email per client.
-- Additive and idempotent. NULL = never queued (every older row), 'pending' = waiting for the next
-- roll-up, 'sending' = claimed by a running roll-up, 'sent' = included in a roll-up.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS client_digest_status TEXT,
  ADD COLUMN IF NOT EXISTS client_digest_queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_digest_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_digest_sent_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_replies_client_digest_status_check') THEN
    ALTER TABLE pending_replies ADD CONSTRAINT pending_replies_client_digest_status_check
      CHECK (client_digest_status IS NULL OR client_digest_status IN ('pending', 'sending', 'sent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pending_replies_client_digest
  ON pending_replies (client_id)
  WHERE client_digest_status IN ('pending', 'sending');
