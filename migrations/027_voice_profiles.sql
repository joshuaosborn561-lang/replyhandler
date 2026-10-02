-- Weekly voice learning (Friday cron).
--
-- original_draft: the AI draft as it stood before Josh edited it in Slack. The
-- edit handler overwrites draft_reply with the final text, so without this the
-- "what did he change" signal is lost. Written best-effort on edit.
ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS original_draft TEXT;

-- Every learning run writes a NEW row per scope; nothing is ever updated or
-- deleted, so every week's style is kept indefinitely. Drafts always read the
-- newest row. A revert copies an earlier row forward as the new newest
-- (restored_from points back at it), so the weekly job keeps auto-updating
-- from the restored version — nothing is frozen.
CREATE TABLE IF NOT EXISTS voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'client')),
  client_id UUID REFERENCES clients(id),
  week_ending DATE NOT NULL,
  profile JSONB NOT NULL,
  examples_used INTEGER NOT NULL DEFAULT 0,
  edited_used INTEGER NOT NULL DEFAULT 0,
  manual_used INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  trigger TEXT,
  restored_from UUID REFERENCES voice_profiles(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT voice_profiles_scope_client CHECK (
    (scope = 'global' AND client_id IS NULL) OR (scope = 'client' AND client_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS voice_profiles_latest_idx
  ON voice_profiles (scope, client_id, created_at DESC);

-- History is permanent. Same pattern as protect_clients_delete.
CREATE OR REPLACE FUNCTION prevent_voice_profiles_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deleting voice_profiles rows is disabled; pin an earlier version instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_voice_profiles_delete ON voice_profiles;
CREATE TRIGGER protect_voice_profiles_delete
BEFORE DELETE ON voice_profiles
FOR EACH ROW EXECUTE FUNCTION prevent_voice_profiles_delete();

-- TRUNCATE skips row triggers, so block it separately.
DROP TRIGGER IF EXISTS protect_voice_profiles_truncate ON voice_profiles;
CREATE TRIGGER protect_voice_profiles_truncate
BEFORE TRUNCATE ON voice_profiles
FOR EACH STATEMENT EXECUTE FUNCTION prevent_voice_profiles_delete();

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
