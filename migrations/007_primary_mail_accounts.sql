-- 007_primary_mail_accounts.sql
-- App-level primary mailbox (Gmail) used to notify clients with thread + enrichment.
-- Separate from per-client calendar_connections.

CREATE TABLE IF NOT EXISTS primary_mail_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail')),
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider)
);

CREATE INDEX IF NOT EXISTS idx_primary_mail_accounts_email
  ON primary_mail_accounts (email);
