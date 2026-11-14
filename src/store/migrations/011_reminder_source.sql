-- A reminder can belong to the message it was set for, and records when it last fired (docs/spec.md 4.6).
ALTER TABLE reminders ADD COLUMN source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE reminders ADD COLUMN last_fired_at INTEGER;
