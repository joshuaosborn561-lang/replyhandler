-- Follow-up card clicks and outcomes, for the "View full thread & history" modal.
-- Additive. A missing table only means the modal has no click timeline yet.

CREATE TABLE IF NOT EXISTS followup_card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID,
  sequence_id UUID,
  step_id UUID,
  pending_reply_id UUID,
  lead_key TEXT,
  event_type TEXT NOT NULL,
  action_id TEXT,
  outcome TEXT,
  slack_user_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followup_card_events_lead
  ON followup_card_events (client_id, lead_key, created_at);

CREATE INDEX IF NOT EXISTS idx_followup_card_events_reply
  ON followup_card_events (pending_reply_id, created_at);
