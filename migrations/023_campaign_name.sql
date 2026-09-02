-- Persist campaign name so Slack cards show the human name, not only the numeric ID.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS campaign_name TEXT;
