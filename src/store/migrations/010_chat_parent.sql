-- A thread can belong to a channel chat that holds its background (docs/spec.md 4.2).
ALTER TABLE chats ADD COLUMN parent_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
