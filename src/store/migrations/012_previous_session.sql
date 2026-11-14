-- The session a cold start replaced, so the switch can be undone (docs/spec.md 4.1).
ALTER TABLE agents ADD COLUMN previous_session_id TEXT;
