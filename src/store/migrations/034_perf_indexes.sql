-- Speed up per-agent reminder listing and per-chat pending-message scans during console polling.
CREATE INDEX IF NOT EXISTS reminders_agent ON reminders(agent_id, next_fire_at) WHERE next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_chat_attention ON messages(chat_id, created_at)
  WHERE direction = 'in' AND state IN ('unanswered', 'failed', 'waiting', 'held');
