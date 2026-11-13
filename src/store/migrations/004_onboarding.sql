-- Completing onboarding is a lifetime milestone, independent of recent activity.
ALTER TABLE agents ADD COLUMN has_replied INTEGER NOT NULL DEFAULT 0 CHECK (has_replied IN (0, 1));

UPDATE agents SET has_replied = 1
WHERE id IN (
  SELECT n.agent_id FROM messages m
  JOIN chats c ON c.id = m.chat_id
  JOIN connections n ON n.id = c.connection_id
  WHERE m.direction = 'out' AND m.state = 'sent'
);

CREATE TRIGGER messages_onboarding_insert AFTER INSERT ON messages
WHEN new.direction = 'out' AND new.state = 'sent'
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id
  );
END;

CREATE TRIGGER messages_onboarding_update AFTER UPDATE OF state ON messages
WHEN new.direction = 'out' AND new.state = 'sent'
BEGIN
  UPDATE agents SET has_replied = 1
  WHERE has_replied = 0 AND id = (
    SELECT n.agent_id FROM chats c JOIN connections n ON n.id = c.connection_id
    WHERE c.id = new.chat_id
  );
END;
