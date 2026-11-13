-- An agent's environment variables. Only the names are here: each value lives in the
-- system credential store under the ref `env:<agent_id>:<name>`.
CREATE TABLE agent_env (
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, name)
) STRICT;
