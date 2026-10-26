-- Message-ID of the prospect email.
--
-- The reply webhook, the category-changed webhook, and the SmartLead inbox
-- poller can all deliver the same email. The RFC 5322 Message-ID is the
-- same on each of them. Dedupe matches that id for the same person inside
-- the claim lock, before any text comparison. It is not a time window and
-- not a SmartLead stats id (those were tried and removed).
--
-- inbound_forwards uses the same id so the portal / campaign forward fires
-- once even when the two renderings of the body diverge.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS inbound_message_id TEXT;

COMMENT ON COLUMN pending_replies.inbound_message_id IS
  'RFC 5322 Message-ID of this prospect email. Same id is the same email. Not a SmartLead stats id.';

CREATE INDEX IF NOT EXISTS idx_pending_replies_inbound_message_id
  ON pending_replies (client_id, platform, lower(inbound_message_id))
  WHERE inbound_message_id IS NOT NULL AND inbound_message_id <> '';

ALTER TABLE inbound_forwards
  ADD COLUMN IF NOT EXISTS inbound_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS inbound_forwards_message_once
  ON inbound_forwards (campaign_id, lead_key, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL AND inbound_message_id <> '';
