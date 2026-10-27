-- Addresses the prospect typed for someone else, when the send CC'd them.
-- Comma-separated. Empty when the reply named a person and gave no address.
-- Best-effort: a missing column must not drop the inbound insert.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS referral_cc TEXT;

COMMENT ON COLUMN pending_replies.referral_cc IS
  'Comma-separated emails the prospect wrote for a referred contact, and the addresses actually CC''d on send. Never constructed from a name.';
