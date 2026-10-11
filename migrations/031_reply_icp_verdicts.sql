-- ICP verdict cache for Slack reply cards (client_tag + domain).
-- Reads topup.icp_variants / icp_llm_results first; local rows are the
-- miss-path cache so a second reply from the same company is free.
-- Never writes dl_status / sg_exclude / skip_*.

CREATE TABLE IF NOT EXISTS reply_icp_verdicts (
  client_tag TEXT NOT NULL,
  domain TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('qualified', 'disqualified', 'unknown')),
  confidence NUMERIC,
  reason TEXT,
  label TEXT,
  pass_label TEXT,
  source TEXT,
  cost_usd NUMERIC,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, domain)
);

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS icp_verdict JSONB;
