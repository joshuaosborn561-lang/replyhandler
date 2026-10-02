-- Optional per-client Allo key, mirrored to the portal on provision.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS allo_api_key TEXT;
