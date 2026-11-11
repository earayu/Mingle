-- The platform user who owns this bot. Claimed by the first direct message after connecting.
ALTER TABLE connections ADD COLUMN owner_id TEXT;
-- Whether the agent was already reminded about this message once.
ALTER TABLE messages ADD COLUMN nudged INTEGER NOT NULL DEFAULT 0;
