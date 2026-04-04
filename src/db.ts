// ── ULTRON Hub v5 — SQLite Database ──────────────────────────────────────────

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ── Path resolution ─────────────────────────────────────────────────────────
const ULTRON_DIR = join(homedir(), ".ultron");
const DB_PATH = process.env.ULTRON_DB_PATH ?? join(ULTRON_DIR, "ultron.db");

// ── Schema DDL ──────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
-- memories: persistent key-value knowledge per project
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  project          TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'fact'
                   CHECK (category IN ('fact','pattern','preference','warning','note')),
  tool             TEXT,
  expires_at       TEXT,
  last_accessed_at TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  UNIQUE (project, key)
);

-- sessions: work session history per tool
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

-- decisions: immutable technical decision log
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  choice      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- tasks: persistent project backlog
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','done')),
  priority    TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('high','medium','low')),
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  done_at     TEXT
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories  (project);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories  (project, category);
CREATE INDEX IF NOT EXISTS idx_memories_expires  ON memories  (project, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_project  ON sessions  (project, tool);
CREATE INDEX IF NOT EXISTS idx_sessions_ended    ON sessions  (project, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions (project);
CREATE INDEX IF NOT EXISTS idx_tasks_project     ON tasks     (project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks     (project, priority)
  WHERE status = 'pending';

-- FTS5 full-text search on memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  key, value,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value)
    VALUES ('delete', old.rowid, old.key, old.value);
  INSERT INTO memories_fts(rowid, key, value)
    VALUES (new.rowid, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value)
    VALUES ('delete', old.rowid, old.key, old.value);
END;

-- Schema versioning
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');
`;

// ── Initialize ──────────────────────────────────────────────────────────────
function initDb(): DatabaseType {
  mkdirSync(ULTRON_DIR, { recursive: true });
  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);

  return db;
}

export const db = initDb();
export const uuid = randomUUID;
