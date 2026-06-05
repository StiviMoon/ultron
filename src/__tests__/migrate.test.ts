// ── ULTRON v8 — migration idempotency + project-merge tests ───────────────────

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";

function seedV7(db: Database.Database) {
  // Minimal v7-style memories table (no agent/embedded_at) to prove the v8 migration adds them.
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'fact', tool TEXT, expires_at TEXT, last_accessed_at TEXT,
    related TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE (project, key)
  );`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, tool TEXT, summary TEXT, files TEXT, started_at TEXT, ended_at TEXT, created_at TEXT);`);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT, text TEXT, status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'medium', tool TEXT, created_at TEXT, done_at TEXT);`);
  db.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, project TEXT, topic TEXT, choice TEXT, reason TEXT, tool TEXT, created_at TEXT);`);
  db.exec(`CREATE TABLE memory_links (from_id TEXT, to_id TEXT, relation TEXT DEFAULT 'manual', weight REAL DEFAULT 1.0, created_at TEXT, PRIMARY KEY (from_id,to_id,relation));`);
  db.exec(`CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent TEXT, project TEXT, action TEXT, detail TEXT, started_at TEXT, ended_at TEXT);`);
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`INSERT INTO _meta (key,value) VALUES ('schema_version','7');`);
  const ins = db.prepare("INSERT INTO memories (id,project,key,value) VALUES (?,?,?,?)");
  ins.run("1", "MJ", "stack", "next");        // MJ → mj
  ins.run("2", "mj", "api", "express");        // canonical (mj has more rows)
  ins.run("3", "mj", "db", "supabase");
  ins.run("4", "MJ", "stack-dup", "x");        // unique to MJ → moves to mj
  ins.run("5", "mj", "stack", "WILL-WIN");     // collision key with id 1 → mj keeps its own
}

describe("migrations", () => {
  let db: Database.Database;
  beforeAll(() => {
    db = new Database(":memory:");
    seedV7(db);
    runMigrations(db);
  });

  it("bumps schema_version to 9", () => {
    const v = (db.prepare("SELECT value FROM _meta WHERE key='schema_version'").get() as { value: string }).value;
    expect(v).toBe("9");
  });

  it("adds v8 columns (agent, embedded_at)", () => {
    const cols = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("agent");
    expect(cols).toContain("embedded_at");
  });

  it("merges MJ into mj, keeping canonical on key collision", () => {
    expect((db.prepare("SELECT COUNT(*) c FROM memories WHERE project='MJ'").get() as { c: number }).c).toBe(0);
    // mj 'stack' must keep the canonical mj value, not the merged-in MJ one
    const stack = db.prepare("SELECT value FROM memories WHERE project='mj' AND key='stack'").get() as { value: string };
    expect(stack.value).toBe("WILL-WIN");
    // unique MJ key moved over
    expect(db.prepare("SELECT COUNT(*) c FROM memories WHERE project='mj' AND key='stack-dup'").get()).toEqual({ c: 1 });
  });

  it("is idempotent — re-running changes nothing", () => {
    const before = db.prepare("SELECT COUNT(*) c FROM memories").get();
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT COUNT(*) c FROM memories").get()).toEqual(before);
  });
});

describe("schema", () => {
  it("applies cleanly on a fresh DB", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ["memories", "sessions", "tasks", "decisions", "memory_links", "agents", "agent_runs"]) {
      expect(tables).toContain(t);
    }
  });
});
