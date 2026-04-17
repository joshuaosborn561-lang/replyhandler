-- Prefer a single source of truth: draft_reply = original AI draft (never overwritten on Edit & send).
ALTER TABLE pending_replies DROP COLUMN IF EXISTS ai_draft_reply;
