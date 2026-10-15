-- Josh never uses a Calendly personal access token. Open times come from
-- the public booking page (and connected calendar as a leftover helper).
-- Drop the unused column. Migration 004 remains in history.

ALTER TABLE clients
  DROP COLUMN IF EXISTS calendly_personal_access_token;
