-- Optional per-client Calendly Personal Access Token for real availability in AI drafts.
-- https://developer.calendly.com/how-to-authenticate-with-personal-access-tokens
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calendly_personal_access_token TEXT;
