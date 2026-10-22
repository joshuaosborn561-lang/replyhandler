-- Reply cards show the PERSON's full name, location and time zone (not company HQ).
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS lead_full_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_location TEXT,
  ADD COLUMN IF NOT EXISTS lead_timezone TEXT;
