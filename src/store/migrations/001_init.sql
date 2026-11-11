-- Mingle runtime state. Agent content (ROLE.md, MEMORY.md, notes/) lives in files, not here.
-- IDs are short text IDs minted by Mingle; a prefix marks the kind (a_, n_, c, m, t, r).

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,            -- directory name under ~/.mingle/agents/
  name          TEXT NOT NULL,
  avatar        TEXT,                            -- file name inside the agent home, or NULL
  harness       TEXT NOT NULL,                   -- OAR runtime id: claude, codex, ...
  model         TEXT,                            -- NULL = harness default
  session_id    TEXT,                            -- current OAR session id, NULL before first run
  status        TEXT NOT NULL DEFAULT 'offline', -- offline | idle | thinking | working | error
  status_detail TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE connections (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,                   -- feishu | dingtalk | wecom | slack | discord | telegram
  bot_id        TEXT,                            -- platform-side bot/app id, set once onboarded
  bot_name      TEXT,
  state         TEXT NOT NULL,                   -- awaiting_credentials | awaiting_approval | connected | reconnecting | error
  state_detail  TEXT,
  secret_ref    TEXT,                            -- Keychain item name; the secret itself is never stored here
  access        TEXT NOT NULL DEFAULT 'open',    -- open | allowlist
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX connections_agent ON connections(agent_id);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,                -- c12
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform_id   TEXT NOT NULL,                   -- platform chat id, plus thread/topic id when present
  kind          TEXT NOT NULL,                   -- dm | group | thread
  name          TEXT,
  is_owner_dm   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (connection_id, platform_id)
) STRICT;

CREATE TABLE messages (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,            -- m8f2a
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL,                   -- in | out
  platform_id   TEXT,                            -- platform message id; NULL while an outbound send is pending
  sender_id     TEXT,                            -- platform user id; NULL for the agent itself
  sender_name   TEXT,
  body          TEXT NOT NULL,
  attachments   TEXT,                            -- JSON array of { id, name, size, mime }
  reply_to      TEXT,                            -- messages.id this one quotes
  triggers      INTEGER NOT NULL DEFAULT 0,      -- inbound: 1 if it should wake the agent
  state         TEXT NOT NULL,                   -- inbound: received | delivered | replied | unanswered | ignored
                                                 -- outbound: pending | sent | failed | uncertain
  input_id      TEXT,                            -- OAR inputId used to deliver it, for idempotent redelivery
  created_at    INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX messages_platform ON messages(chat_id, platform_id) WHERE platform_id IS NOT NULL;
CREATE INDEX messages_chat_time ON messages(chat_id, created_at);
CREATE INDEX messages_pending ON messages(state) WHERE state IN ('received', 'pending');

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,                -- t3
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'todo',    -- todo | in_progress | done | closed
  from_message  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  from_chat     TEXT REFERENCES chats(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_agent_status ON tasks(agent_id, status);

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,                -- r2
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  rule          TEXT NOT NULL,                   -- once | every:15m | daily@09:00 | weekly:mon,fri@09:00
  timezone      TEXT NOT NULL,                   -- IANA zone the rule was set in
  chat_id       TEXT REFERENCES chats(id) ON DELETE SET NULL,
  next_fire_at  INTEGER,                         -- NULL once a one-off reminder has fired
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX reminders_due ON reminders(next_fire_at) WHERE next_fire_at IS NOT NULL;
