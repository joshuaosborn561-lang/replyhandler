-- Optional portal login email. Empty means skip the portal invite.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
