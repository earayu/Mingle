-- Global outbound network proxy settings (docs/spec.md 9.1).
-- Single-row table; proxy credentials (username/password) live only in the system credential store.

CREATE TABLE proxy_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  mode            TEXT NOT NULL DEFAULT 'system', -- system | manual | off
  url             TEXT,                           -- manual proxy URL without credentials
  has_auth        INTEGER NOT NULL DEFAULT 0,     -- 1 when credentials are stored in Keychain
  bypass          TEXT NOT NULL DEFAULT '',       -- comma-separated bypass rules
  pass_to_harness INTEGER NOT NULL DEFAULT 1,     -- pass active proxy as fallback env to harnesses
  updated_at      INTEGER NOT NULL
) STRICT;
