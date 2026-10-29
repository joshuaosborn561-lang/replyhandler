-- Follow-up cards show the lead's title and company. Both are captured when the reply card is
-- posted (the decision-maker check already extracts the title; the webhook carries the company).
-- Additive and idempotent. Older rows have neither; the card falls back to the decision-maker
-- title and the work-email domain.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS lead_title TEXT,
  ADD COLUMN IF NOT EXISTS lead_company TEXT;
