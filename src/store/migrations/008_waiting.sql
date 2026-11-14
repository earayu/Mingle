-- Inbound messages that hit a passing failure (a usage limit, a rate limit, a busy provider) wait
-- and are delivered again by themselves (docs/spec.md 4.3, 4.10): state 'waiting' until retry_at.
-- holds counts the waits, so a failure that keeps coming back ends as 'failed' for the owner.
ALTER TABLE messages ADD COLUMN retry_at INTEGER;
ALTER TABLE messages ADD COLUMN holds INTEGER NOT NULL DEFAULT 0;
CREATE INDEX messages_waiting ON messages(retry_at) WHERE state = 'waiting';
