-- One CC heads-up email per reply Josh CC'd a client on (Nov 4 2026).
-- The timestamp is the claim. A second send for the same reply does not
-- email the client again. NULL means the heads-up has not gone out.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS cc_heads_up_sent_at TIMESTAMPTZ;
