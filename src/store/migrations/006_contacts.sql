-- The agent's address book: one row per person per bot (docs/spec.md 3, 4.2).
-- The same human on two chat apps, or on two WeChat bots, is two contacts; Mingle does not merge them.
CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,                -- u7k2p, shown to the agent as user=
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform_id   TEXT NOT NULL,                   -- platform user id
  name          TEXT,                            -- the latest name the platform reported, if any
  alias         TEXT,                            -- the name the owner or the agent gave them; wins over name
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (connection_id, platform_id)
) STRICT;
-- Existing senders and owners are filled in by Store on upgrade: IDs are minted in code.
