-- Weekly voice learning (Friday cron).
--
-- original_draft: the AI draft as it stood before Josh edited it in Slack. The
-- edit handler overwrites draft_reply with the final text, so without this the
-- "what did he change" signal is lost. Written best-effort on edit.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS original_draft TEXT;

-- One synthesized profile per scope per week. Latest row wins at draft time;
-- older rows stay as history so a bad week can be compared against the prior one.
CREATE TABLE IF NOT EXISTS voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'client')),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  week_ending DATE NOT NULL,
  profile JSONB NOT NULL,
  examples_used INTEGER NOT NULL DEFAULT 0,
  edited_used INTEGER NOT NULL DEFAULT 0,
  manual_used INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT voice_profiles_scope_client CHECK (
    (scope = 'global' AND client_id IS NULL) OR (scope = 'client' AND client_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_profiles_scope_week_idx
  ON voice_profiles (scope, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), week_ending);

CREATE INDEX IF NOT EXISTS voice_profiles_latest_idx
  ON voice_profiles (scope, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_learning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  lookback_hours INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'cron',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  summary JSONB,
  error TEXT
);
