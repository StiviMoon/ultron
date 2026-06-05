// ── ULTRON v8 — declarative schema DDL ────────────────────────────────────────
// Base tables only. Incremental column/table changes live in migrate.ts so a
// schema_version pivot drives upgrades — no blind try/catch ALTER on every boot.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  project          TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'fact'
                   CHECK (category IN ('fact','pattern','preference','warning','note','rule')),
  tool             TEXT,
  agent            TEXT,
  expires_at       TEXT,
  last_accessed_at TEXT,
  access_count     INTEGER NOT NULL DEFAULT 0,
  importance       INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  related          TEXT DEFAULT '[]',
  embedded_at      TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  UNIQUE (project, key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  summary     TEXT,
  files       TEXT DEFAULT '[]',
  started_at  TEXT DEFAULT (datetime('now')),
  ended_at    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  choice      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  priority    TEXT NOT NULL DEFAULT 'medium'  CHECK (priority IN ('high','medium','low')),
  tags        TEXT DEFAULT '[]',
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  done_at     TEXT
);

-- knowledge graph edges (derived from memories.related + semantic suggestions)
CREATE TABLE IF NOT EXISTS memory_links (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL DEFAULT 'manual' CHECK (relation IN ('manual','semantic')),
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (from_id, to_id, relation)
);

-- agent registry + run audit (P1 ecosystem)
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL DEFAULT 'subagent' CHECK (type IN ('subagent','daemon')),
  capabilities  TEXT DEFAULT '[]',
  registered_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  project    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at   TEXT
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories  (project);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories  (project, category);
CREATE INDEX IF NOT EXISTS idx_memories_expires  ON memories  (project, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_score    ON memories  (project, access_count DESC, importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project  ON sessions  (project, tool);
CREATE INDEX IF NOT EXISTS idx_sessions_ended    ON sessions  (project, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions (project);
CREATE INDEX IF NOT EXISTS idx_tasks_project     ON tasks     (project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks     (project, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_links_from        ON memory_links (from_id);
CREATE INDEX IF NOT EXISTS idx_links_to          ON memory_links (to_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent        ON agent_runs (agent, started_at DESC);

-- FTS5 keyword index on memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  key, value, content=memories, content_rowid=rowid, tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
  INSERT INTO memories_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
END;

CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** Embedding dimensions for the local MiniLM-L6-v2 model */
export const EMBED_DIM = 384;

/** sqlite-vec virtual table for semantic search. rowid = memories.rowid. */
export const VEC_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
  embedding float[${EMBED_DIM}]
);
`;
