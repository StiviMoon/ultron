#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools/memory.tools.ts
import { z } from "zod";

// src/db/connection.ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
import { randomUUID } from "crypto";

// src/db/schema.ts
var SCHEMA_SQL = `
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
var EMBED_DIM = 384;
var VEC_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
  embedding float[${EMBED_DIM}]
);
`;

// src/lib/logger.ts
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var ULTRON_DIR = process.env.ULTRON_DIR ?? join(homedir(), ".ultron");
var LOG_PATH = process.env.ULTRON_LOG_PATH ?? join(ULTRON_DIR, "ultron.log");
var LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
var MIN_LEVEL = process.env.ULTRON_LOG_LEVEL ?? "info";
function write(level, msg, meta) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg, ...meta && { meta } });
  try {
    mkdirSync(ULTRON_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
  }
  if (level === "error" || level === "warn") console.error("[ULTRON]", msg);
}
var log = {
  debug: (msg, meta) => write("debug", msg, meta),
  info: (msg, meta) => write("info", msg, meta),
  warn: (msg, meta) => write("warn", msg, meta),
  error: (msg, meta) => write("error", msg, meta)
};

// src/db/migrate.ts
function addColumnIfMissing(db2, table, column, ddl) {
  const cols = db2.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db2.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
var MIGRATIONS = [
  {
    version: 8,
    name: "v7-to-v8: agent + embedding columns",
    up: (db2) => {
      addColumnIfMissing(db2, "memories", "agent", "agent TEXT");
      addColumnIfMissing(db2, "memories", "embedded_at", "embedded_at TEXT");
      addColumnIfMissing(db2, "memories", "related", "related TEXT DEFAULT '[]'");
      addColumnIfMissing(db2, "memories", "access_count", "access_count INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db2, "memories", "importance", "importance INTEGER NOT NULL DEFAULT 5");
      addColumnIfMissing(db2, "tasks", "tags", "tags TEXT DEFAULT '[]'");
    }
  },
  {
    version: 9,
    name: "normalize project names (merge case duplicates)",
    up: (db2) => {
      const rows = db2.prepare(
        `SELECT project, COUNT(*) c FROM (
             SELECT project FROM memories UNION ALL
             SELECT project FROM sessions UNION ALL
             SELECT project FROM tasks UNION ALL
             SELECT project FROM decisions
           ) GROUP BY project`
      ).all();
      const groups = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const norm = r.project.trim().toLowerCase();
        const g = groups.get(norm);
        if (!g) {
          groups.set(norm, { canonical: r.project, max: r.c, all: [r.project] });
        } else {
          g.all.push(r.project);
          if (r.c > g.max) {
            g.max = r.c;
            g.canonical = r.project;
          }
        }
      }
      const tables = ["memories", "sessions", "tasks", "decisions", "agent_runs"];
      for (const { canonical, all: all2 } of groups.values()) {
        const variants = all2.filter((p) => p !== canonical);
        if (variants.length === 0) continue;
        log.info("merging project variants", { canonical, variants });
        for (const v of variants) {
          for (const t of tables) {
            if (t === "memories") {
              db2.prepare(
                `UPDATE OR IGNORE memories SET project = ? WHERE project = ?`
              ).run(canonical, v);
              db2.prepare(`DELETE FROM memories WHERE project = ?`).run(v);
            } else {
              const has = db2.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
              ).get(t);
              if (has) db2.prepare(`UPDATE ${t} SET project = ? WHERE project = ?`).run(canonical, v);
            }
          }
        }
      }
    }
  },
  {
    version: 10,
    name: "memory_links FK cascade + decisions supersedes",
    up: (db2) => {
      addColumnIfMissing(db2, "decisions", "supersedes", "supersedes TEXT");
      const hasFk = db2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_links'").get();
      if (hasFk?.sql?.includes("REFERENCES memories")) return;
      db2.exec(`
        CREATE TABLE memory_links_new (
          from_id    TEXT NOT NULL,
          to_id      TEXT NOT NULL,
          relation   TEXT NOT NULL DEFAULT 'manual' CHECK (relation IN ('manual','semantic')),
          weight     REAL NOT NULL DEFAULT 1.0,
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (from_id, to_id, relation),
          FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
          FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE
        );
      `);
      db2.exec(`
        INSERT OR IGNORE INTO memory_links_new (from_id, to_id, relation, weight, created_at)
        SELECT l.from_id, l.to_id, l.relation, l.weight, l.created_at
        FROM memory_links l
        WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = l.from_id)
          AND EXISTS (SELECT 1 FROM memories m WHERE m.id = l.to_id);
      `);
      db2.exec("DROP TABLE memory_links;");
      db2.exec("ALTER TABLE memory_links_new RENAME TO memory_links;");
      db2.exec("CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links (from_id);");
      db2.exec("CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links (to_id);");
    }
  }
];
function runMigrations(db2) {
  const row = db2.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get();
  const current = row ? parseInt(row.value, 10) : 0;
  const pending2 = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending2.length === 0) return;
  const tx = db2.transaction(() => {
    for (const m of pending2) {
      log.info("running migration", { version: m.version, name: m.name });
      m.up(db2);
      db2.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(
        String(m.version)
      );
    }
  });
  tx();
  log.info("migrations complete", { from: current, to: pending2[pending2.length - 1].version });
}

// src/db/connection.ts
var ULTRON_DIR2 = process.env.ULTRON_DIR ?? join2(homedir2(), ".ultron");
var DB_PATH = process.env.ULTRON_DB_PATH ?? join2(ULTRON_DIR2, "ultron.db");
var vecEnabled = false;
function initDb() {
  mkdirSync2(ULTRON_DIR2, { recursive: true });
  const db2 = new Database(DB_PATH);
  db2.pragma("journal_mode = WAL");
  db2.pragma("busy_timeout = 5000");
  db2.pragma("foreign_keys = ON");
  try {
    sqliteVec.load(db2);
    db2.exec(VEC_SCHEMA_SQL);
    vecEnabled = true;
    const { v } = db2.prepare("SELECT vec_version() AS v").get();
    log.info("sqlite-vec loaded", { version: v });
  } catch (e) {
    vecEnabled = false;
    log.warn("sqlite-vec unavailable \u2014 semantic search disabled", { error: String(e) });
  }
  db2.exec(SCHEMA_SQL);
  runMigrations(db2);
  return db2;
}
var db = initDb();
var uuid = randomUUID;
var isVecEnabled = () => vecEnabled;

// src/lib/result.ts
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function text(content) {
  return { content: [{ type: "text", text: content }] };
}
function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}
function errOf(e) {
  const msg = e instanceof Error ? e.message : String(e);
  log.error("operation failed", { error: msg });
  return msg;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}

// src/lib/define-tool.ts
function defineTool(server2, name, description, schema, handler) {
  server2.tool(name, description, schema, async (args) => {
    try {
      const result = await handler(args);
      if (isMcpResult(result)) return result;
      return ok(result);
    } catch (e) {
      const msg = errOf(e);
      log.error(`tool ${name} failed`, { error: msg });
      return err(msg);
    }
  });
}
function defineTextTool(server2, name, description, schema, handler) {
  server2.tool(name, description, schema, async (args) => {
    try {
      const result = await handler(args);
      if (typeof result === "string") return text(result);
      if (isMcpResult(result)) return result;
      return text(String(result));
    } catch (e) {
      const msg = errOf(e);
      log.error(`tool ${name} failed`, { error: msg });
      return err(msg);
    }
  });
}
function isMcpResult(v) {
  return typeof v === "object" && v !== null && "content" in v && Array.isArray(v.content);
}

// src/lib/next-actions.ts
function withActions(data, actions) {
  return actions.length > 0 ? { ...data, next_actions: actions } : data;
}
function sessionStartActions(ctx) {
  const actions = [];
  const warnings = (ctx.memories ?? []).filter((m) => m.category === "warning").length;
  if ((ctx.rules?.length ?? 0) > 0) actions.push("Read rules first \u2014 they override defaults");
  if (warnings > 0) actions.push(`${warnings} warning(s) loaded \u2014 check before changing related code`);
  if ((ctx.pending_tasks?.length ?? 0) > 0) actions.push("Review pending_tasks and confirm priority with user");
  actions.push("Call session_end with summary + files when done");
  return actions;
}
function rememberActions(warnings, similarCount) {
  const actions = [];
  if (similarCount > 0) actions.push("Similar keys exist \u2014 update existing key instead of duplicating");
  if (warnings.some((w) => w.includes("Long value"))) actions.push("Consider saving long content as a .md file and referencing the path");
  actions.push("Use search() to verify this knowledge is retrievable");
  return actions;
}
function taskDoneActions(highPending) {
  const actions = [];
  if (highPending > 0) actions.push(`${highPending} high-priority task(s) remaining`);
  else actions.push("No high-priority tasks left \u2014 check medium/low backlog");
  return actions;
}
function healthActions(score, issueCount) {
  if (score >= 80) return ["Project memory is healthy \u2014 continue working"];
  if (issueCount > 0) return ["Address health issues before adding more memories", "Run clean(project, action='list') for stale entries"];
  return ["Run token_budget(project) to optimize recall cost"];
}

// src/services/embedding.service.ts
import { join as join3 } from "path";
import { homedir as homedir3 } from "os";
var ULTRON_DIR3 = process.env.ULTRON_DIR ?? join3(homedir3(), ".ultron");
var MODEL_ID = "Xenova/all-MiniLM-L6-v2";
process.env.HF_HOME = process.env.HF_HOME ?? join3(ULTRON_DIR3, "models");
var extractorPromise = null;
var available = true;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const t0 = Date.now();
      const ex = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
      log.info("embedding model loaded", { model: MODEL_ID, ms: Date.now() - t0 });
      return ex;
    })();
  }
  return extractorPromise;
}
function warmupEmbeddings() {
  if (!available) return;
  void getExtractor().catch(() => {
  });
}
async function embedOne(text3) {
  const out = await embedMany([text3]);
  return out?.[0] ?? null;
}
async function embedMany(texts) {
  if (!available || texts.length === 0) return null;
  try {
    const ex = await getExtractor();
    const res = await ex(texts, { pooling: "mean", normalize: true });
    const [n, dim] = res.dims;
    if (dim !== EMBED_DIM) throw new Error(`unexpected embedding dim ${dim}, expected ${EMBED_DIM}`);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(res.data.slice(i * dim, (i + 1) * dim));
    }
    return out;
  } catch (e) {
    available = false;
    log.error("embedding failed \u2014 disabling semantic features", { error: String(e) });
    return null;
  }
}

// src/repositories/vector.repo.ts
function upsertVector(rowid, vec) {
  if (!isVecEnabled()) return;
  const rid = BigInt(rowid);
  db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(rid);
  db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)").run(rid, vec);
}
async function embedMemory(memoryId) {
  if (!isVecEnabled()) return false;
  const row = db.prepare("SELECT rowid, key, value FROM memories WHERE id = ?").get(memoryId);
  if (!row) return false;
  const vec = await embedOne(`${row.key}
${row.value}`);
  if (!vec) return false;
  upsertVector(row.rowid, vec);
  db.prepare("UPDATE memories SET embedded_at = datetime('now') WHERE id = ?").run(memoryId);
  return true;
}
async function backfillEmbeddings(batchSize = 32) {
  if (!isVecEnabled()) return 0;
  const pending2 = db.prepare("SELECT rowid, id, key, value FROM memories WHERE embedded_at IS NULL").all();
  let done = 0;
  for (let i = 0; i < pending2.length; i += batchSize) {
    const batch = pending2.slice(i, i + batchSize);
    const vecs = await embedMany(batch.map((r) => `${r.key}
${r.value}`));
    if (!vecs) break;
    const tx = db.transaction(() => {
      batch.forEach((r, j) => {
        upsertVector(r.rowid, vecs[j]);
        db.prepare("UPDATE memories SET embedded_at = datetime('now') WHERE id = ?").run(r.id);
      });
    });
    tx();
    done += batch.length;
    log.info("embedding backfill progress", { done, total: pending2.length });
  }
  return done;
}
async function searchVector(query, projects, limit = 20) {
  if (!isVecEnabled()) return [];
  const vec = await embedOne(query);
  if (!vec) return [];
  const placeholders = projects.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT m.id AS id, v.distance AS distance
       FROM vec_memories v
       JOIN memories m ON m.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
         AND m.project IN (${placeholders})
         AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
       ORDER BY v.distance`
  ).all(vec, limit * 3, ...projects);
  return rows.slice(0, limit);
}
function deleteVector(rowid) {
  if (!isVecEnabled()) return;
  try {
    db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(rowid));
  } catch {
  }
}

// src/repositories/memory.repo.ts
function upsertMemory(input) {
  db.prepare(
    `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, updated_at, expires_at, related, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (project, key) DO UPDATE SET
       value = excluded.value, category = excluded.category, importance = excluded.importance,
       tool = excluded.tool, agent = excluded.agent, updated_at = excluded.updated_at,
       expires_at = excluded.expires_at, related = excluded.related,
       embedded_at = NULL`
  ).run(
    input.id,
    input.project,
    input.key,
    input.value,
    input.category,
    input.importance,
    input.tool,
    input.agent,
    now(),
    input.expires_at,
    JSON.stringify(input.related)
  );
}
function getByKey(project, key) {
  return db.prepare("SELECT * FROM memories WHERE project = ? AND key = ?").get(project, key);
}
function deleteMemories(project, keys) {
  if (keys.length === 0) return 0;
  const ph = keys.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, rowid FROM memories WHERE project = ? AND key IN (${ph})`).all(project, ...keys);
  if (rows.length === 0) return 0;
  const tx = db.transaction(() => {
    for (const row of rows) deleteVector(row.rowid);
    const ids = rows.map((r) => r.id);
    const idPh = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM memory_links WHERE from_id IN (${idPh}) OR to_id IN (${idPh})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${ph})`).run(project, ...keys);
  });
  tx();
  return rows.length;
}
function deleteByKey(project, key) {
  return deleteMemories(project, [key]) > 0;
}
function findSimilarKeys(project, key, prefix) {
  return db.prepare("SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?").all(project, key, `${prefix}-%`);
}
function purgeExpired(project) {
  const expired = db.prepare(
    `SELECT key FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).all(project);
  return deleteMemories(project, expired.map((e) => e.key));
}
function getStaleMemories(project, thresholdDays) {
  return db.prepare(
    `SELECT key, category, value, last_accessed_at, created_at FROM memories
       WHERE project = ? AND key != '_snapshot'
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-' || ? || ' days'))
       ORDER BY last_accessed_at ASC NULLS FIRST`
  ).all(project, thresholdDays);
}
function getMemoriesByKeys(project, keys) {
  if (keys.length === 0) return [];
  const ph = keys.map(() => "?").join(",");
  return db.prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${ph})`).all(project, ...keys);
}
function saveSnapshot(project, value, tool, id) {
  upsertMemory({
    id,
    project,
    key: "_snapshot",
    value,
    category: "note",
    importance: 7,
    tool,
    agent: null,
    expires_at: null,
    related: []
  });
  const saved = getByKey(project, "_snapshot");
  return saved?.id ?? id;
}
function getRecentKeys(project, limit = 8) {
  return db.prepare(
    "SELECT key FROM memories WHERE project = ? AND key != '_snapshot' ORDER BY updated_at DESC LIMIT ?"
  ).all(project, limit).map((m) => m.key);
}
function getRulesMemories(project, categories) {
  const ph = categories.map(() => "?").join(",");
  return db.prepare(
    `SELECT key, value, category FROM memories WHERE project = ? AND category IN (${ph})
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY CASE category WHEN 'rule' THEN 0 WHEN 'warning' THEN 1 WHEN 'pattern' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END,
                importance DESC, key`
  ).all(project, ...categories);
}
function getRules(project) {
  return db.prepare(
    `SELECT * FROM memories WHERE project = ? AND category = 'rule'
       ORDER BY importance DESC, updated_at DESC`
  ).all(project);
}
function getScoredMemories(project, limit = 20) {
  return db.prepare(
    `SELECT *,
        (access_count * 0.4 + importance * 0.3 +
         MAX(0, 1.0 - CAST((julianday('now') - julianday(updated_at)) AS REAL) / 90.0) * 0.3) AS relevance_score
       FROM memories
       WHERE project = ? AND category != 'rule'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY
         CASE category WHEN 'warning' THEN 20 WHEN 'pattern' THEN 10 WHEN 'preference' THEN 5 ELSE 0 END DESC,
         relevance_score DESC
       LIMIT ?`
  ).all(project, limit);
}
function bumpAccess(ids) {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1
     WHERE id IN (${ph})`
  ).run(...ids);
}
function ftsSearch(query, projects, limit = 20, opts) {
  const ph = projects.map(() => "?").join(",");
  const filters = [];
  const filterArgs = [];
  if (opts?.category) {
    filters.push("m.category = ?");
    filterArgs.push(opts.category);
  }
  if (opts?.minImportance !== void 0) {
    filters.push("m.importance >= ?");
    filterArgs.push(opts.minImportance);
  }
  const extra = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  try {
    return db.prepare(
      `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE fts.memories_fts MATCH ? AND m.project IN (${ph})${extra}
         ORDER BY fts.rank LIMIT ?`
    ).all(query, ...projects, ...filterArgs, limit);
  } catch {
    return db.prepare(
      `SELECT * FROM memories WHERE project IN (${ph}) AND (key LIKE ? OR value LIKE ?)${extra.replace(/m\./g, "")}
         ORDER BY updated_at DESC LIMIT ?`
    ).all(...projects, ...filterArgs, `%${query}%`, `%${query}%`, limit);
  }
}
function getByIds(ids) {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...ids);
}
function allProjects() {
  return db.prepare("SELECT DISTINCT project FROM memories").all().map((r) => r.project);
}
function listForHandoff(project, limit = 20) {
  return db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT ?").all(project, limit);
}
function tokenBudgetRows(project) {
  return {
    memories: db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30").all(project),
    sessions: db.prepare("SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5").all(project),
    tasks: db.prepare("SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'").all(project),
    decisions: db.prepare("SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10").all(project),
    staleCount: db.prepare(
      `SELECT COUNT(*) c FROM memories WHERE project = ? AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-45 days'))`
    ).get(project).c
  };
}

// src/repositories/task.repo.ts
var PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END";
function pending(project) {
  return db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'pending' ORDER BY ${PRIORITY_ORDER}, created_at ASC`).all(project);
}
function all(project) {
  return db.prepare(`SELECT * FROM tasks WHERE project = ? ORDER BY ${PRIORITY_ORDER}, created_at ASC`).all(project);
}
function add(project, text3, priority, tags, tool) {
  const id = uuid();
  db.prepare("INSERT INTO tasks (id, project, text, priority, tags, tool) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    project,
    text3,
    priority,
    JSON.stringify(tags),
    tool
  );
  return id;
}
function resolveId(project, rawId) {
  const pos = parseInt(rawId, 10);
  if (!isNaN(pos) && String(pos) === rawId) {
    return pending(project)[pos - 1]?.id ?? null;
  }
  return rawId;
}
function search(query, projects, limit = 10) {
  const ph = projects.map(() => "?").join(",");
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const likeClauses = terms.map(() => "text LIKE ?").join(" AND ");
  const likeArgs = terms.map((t) => `%${t}%`);
  return db.prepare(
    `SELECT * FROM tasks WHERE project IN (${ph}) AND ${likeClauses}
       ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT ?`
  ).all(...projects, ...likeArgs, limit);
}
function update(project, id, fields) {
  const sets = [];
  const vals = [];
  if (fields.text !== void 0) {
    sets.push("text = ?");
    vals.push(fields.text);
  }
  if (fields.priority !== void 0) {
    sets.push("priority = ?");
    vals.push(fields.priority);
  }
  if (fields.tags !== void 0) {
    sets.push("tags = ?");
    vals.push(JSON.stringify(fields.tags));
  }
  if (sets.length === 0) return;
  vals.push(id, project);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project = ?`).run(...vals);
}
function markDone(project, id) {
  db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND project = ?").run(now(), id, project);
}
function remove(project, id) {
  db.prepare("DELETE FROM tasks WHERE id = ? AND project = ?").run(id, project);
}
function topPending(project, limit = 5) {
  return db.prepare(`SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending' ORDER BY ${PRIORITY_ORDER} LIMIT ?`).all(project, limit);
}

// src/repositories/session.repo.ts
function recentClosed(project, limit = 5) {
  return db.prepare(
    "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?"
  ).all(project, limit);
}
function lastClosed(project) {
  return db.prepare(
    "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
  ).get(project);
}
function open(project, tool) {
  const id = uuid();
  db.prepare("INSERT INTO sessions (id, project, tool) VALUES (?, ?, ?)").run(id, project, tool);
  return id;
}
function findOpen(project, tool) {
  return db.prepare(
    "SELECT id FROM sessions WHERE project = ? AND tool = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get(project, tool);
}
function close(id, summary, files) {
  db.prepare("UPDATE sessions SET summary = ?, files = ?, ended_at = ? WHERE id = ?").run(
    summary,
    JSON.stringify(files),
    now(),
    id
  );
}
function closeStale(project, cutoffIso) {
  return db.prepare(
    `UPDATE sessions SET ended_at = ?, summary = 'Auto-closed \u2014 stale session (>2h without session_end)'
       WHERE project = ? AND ended_at IS NULL AND started_at < ?`
  ).run(now(), project, cutoffIso).changes;
}

// src/repositories/decision.repo.ts
function add2(project, topic, choice, reason, tool, supersedes) {
  const id = uuid();
  db.prepare(
    "INSERT INTO decisions (id, project, topic, choice, reason, tool, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, project, topic, choice, reason, tool, supersedes ?? null);
  return id;
}
function recent(project, limit = 10) {
  return db.prepare("SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(project, limit);
}
function paginate(project, limit, offset) {
  const total = db.prepare("SELECT COUNT(*) c FROM decisions WHERE project = ?").get(project).c;
  const rows = db.prepare("SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(project, limit, offset);
  return { total, rows };
}
function search2(query, projects, limit = 10) {
  const ph = projects.map(() => "?").join(",");
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const clauses = terms.map(() => "(topic LIKE ? OR choice LIKE ? OR reason LIKE ?)").join(" AND ");
  const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return db.prepare(
    `SELECT * FROM decisions WHERE project IN (${ph}) AND ${clauses}
       ORDER BY created_at DESC LIMIT ?`
  ).all(...projects, ...args, limit);
}

// src/lib/rrf.ts
function rrf(lists, k = 60) {
  const scores = /* @__PURE__ */ new Map();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

// src/services/recall.service.ts
function parseJsonArray(s) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}
function fetchProjectContext(project, options = {}) {
  const { slim = false, maxValueLength = 1500, fields, since } = options;
  const loadAll = !fields || fields.length === 0;
  const load2 = (f) => loadAll || (fields?.includes(f) ?? false);
  const sessions = load2("sessions") ? recentClosed(project, 5) : null;
  const rules = getRules(project);
  const memories = load2("memories") ? getScoredMemories(project, 20) : null;
  const tasks = load2("tasks") ? pending(project) : null;
  const decisions = load2("decisions") ? recent(project, 10) : null;
  bumpAccess([...memories ?? [], ...rules].map((m) => m.id));
  const lastSession = sessions?.[0] ?? null;
  const isDiff = !!since;
  const filterSince = (rows, field) => isDiff && rows ? rows.filter((r) => (r[field] ?? "") > since) : rows;
  const fMemories = filterSince(memories, "updated_at");
  const fTasks = filterSince(tasks, "created_at");
  const fDecisions = filterSince(decisions, "created_at");
  const processMemory = (m) => {
    if (slim) return { key: m.key, category: m.category, importance: m.importance };
    const related = parseJsonArray(m.related);
    return {
      key: m.key,
      value: truncate(m.value, maxValueLength),
      category: m.category,
      importance: m.importance,
      ...m.expires_at && { expires_at: m.expires_at },
      ...m.value.length > maxValueLength && { truncated: true },
      ...related.length > 0 && { related }
    };
  };
  return {
    project,
    retrieved_at: now(),
    ...isDiff && { diff_mode: true, since },
    ...slim && { note: "slim mode \u2014 memories without values. Use full recall if you need values." },
    ...rules.length > 0 && { rules: rules.map((m) => ({ key: m.key, value: m.value, importance: m.importance })) },
    last_session: lastSession ? { tool: lastSession.tool, summary: truncate(lastSession.summary ?? "", 400), files: parseJsonArray(lastSession.files), ended_at: lastSession.ended_at } : null,
    recent_sessions: sessions ? sessions.slice(1, 5).map((s) => ({ tool: s.tool, summary: truncate(s.summary ?? "", 200), ended_at: s.ended_at })) : void 0,
    memories: fMemories ? fMemories.map(processMemory) : void 0,
    pending_tasks: fTasks ? fTasks.map((t, i) => {
      const tags = parseJsonArray(t.tags);
      return { position: i + 1, id: t.id, text: t.text, priority: t.priority, ...tags.length > 0 && { tags } };
    }) : void 0,
    recent_decisions: fDecisions ? fDecisions.map((d) => ({ topic: d.topic, choice: d.choice, reason: truncate(d.reason, 300) })) : void 0
  };
}
async function searchMemories(query, projects, mode = "hybrid", limit = 20, filters) {
  const useKeyword = mode === "keyword" || mode === "hybrid";
  const useSemantic = (mode === "semantic" || mode === "hybrid") && isVecEnabled();
  const keywordRows = useKeyword ? ftsSearch(query, projects, limit * 2, filters) : [];
  const semanticHits = useSemantic ? await searchVector(query, projects, limit * 2) : [];
  if (!useSemantic) {
    if (keywordRows.length > 0) bumpAccess(keywordRows.slice(0, limit).map((r) => r.id));
    return keywordRows.slice(0, limit);
  }
  const keywordIds = keywordRows.map((r) => r.id);
  const semanticIds = semanticHits.map((h) => h.id);
  const fused = rrf([keywordIds, semanticIds]);
  const byId = /* @__PURE__ */ new Map();
  for (const r of keywordRows) byId.set(r.id, r);
  const missing = semanticIds.filter((id) => !byId.has(id));
  for (const r of getByIds(missing)) byId.set(r.id, r);
  const ranked = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)).filter((r) => !!r).slice(0, limit);
  bumpAccess(ranked.map((r) => r.id));
  return ranked;
}

// src/services/graph.service.ts
function rebuildManualLinks(project) {
  const memories = db.prepare("SELECT id, key, related FROM memories WHERE project = ?").all(project);
  const keyToId = new Map(memories.map((m) => [m.key, m.id]));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_links WHERE relation = 'manual' AND from_id IN (SELECT id FROM memories WHERE project = ?)").run(project);
    let n = 0;
    for (const m of memories) {
      let keys = [];
      try {
        keys = JSON.parse(m.related || "[]");
      } catch {
        keys = [];
      }
      for (const k of keys) {
        const toId = keyToId.get(k);
        if (!toId || toId === m.id) continue;
        db.prepare(
          "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight) VALUES (?, ?, 'manual', 1.0)"
        ).run(m.id, toId);
        n++;
      }
    }
    return n;
  });
  return tx();
}
async function rebuildSemanticLinks(project, threshold = 0.55, perNode = 3) {
  if (!isVecEnabled()) return 0;
  const memories = db.prepare("SELECT id, key, value FROM memories WHERE project = ? AND key != '_snapshot'").all(project);
  let n = 0;
  db.prepare("DELETE FROM memory_links WHERE relation = 'semantic' AND from_id IN (SELECT id FROM memories WHERE project = ?)").run(project);
  for (const m of memories) {
    const neighbors = await searchVector(`${m.key}
${m.value}`, [project], perNode + 1);
    for (const nb of neighbors) {
      if (nb.id === m.id) continue;
      const sim = 1 - nb.distance / 2;
      if (sim < threshold) continue;
      db.prepare(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight) VALUES (?, ?, 'semantic', ?)"
      ).run(m.id, nb.id, sim);
      n++;
    }
  }
  log.info("semantic links rebuilt", { project, edges: n });
  return n;
}
function neighborhood(project, key, depth = 1) {
  const root = getByKey(project, key);
  if (!root) return { root: key, nodes: [], edges: [] };
  const visited = /* @__PURE__ */ new Set([root.id]);
  let frontier = [root.id];
  const edges = [];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      const links = db.prepare("SELECT from_id, to_id, relation, weight FROM memory_links WHERE from_id = ? OR to_id = ?").all(id, id);
      for (const l of links) {
        const other = l.from_id === id ? l.to_id : l.from_id;
        edges.push({ from: l.from_id, to: l.to_id, relation: l.relation, weight: l.weight });
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  const ids = Array.from(visited);
  const rows = getByIds(ids);
  const idToKey = new Map(rows.map((r) => [r.id, r.key]));
  return {
    root: root.key,
    nodes: rows.map((r) => ({ key: r.key, category: r.category, value: r.value })),
    edges: edges.map((e) => ({ from: idToKey.get(e.from) ?? e.from, to: idToKey.get(e.to) ?? e.to, relation: e.relation, weight: e.weight })).filter((e, i, arr) => arr.findIndex((x) => x.from === e.from && x.to === e.to && x.relation === e.relation) === i)
  };
}

// src/services/search-enrichment.service.ts
function enrichSearchResults(project, query, memories) {
  const resultKeys = new Set(memories.map((m) => m.key));
  const related = [];
  for (const m of memories.slice(0, 3)) {
    try {
      const nb = neighborhood(project, m.key, 1);
      for (const edge of nb.edges) {
        const other = edge.from === m.key ? edge.to : edge.from;
        if (other === "_snapshot" || resultKeys.has(other)) continue;
        related.push({ key: other, relation: edge.relation, via: m.key });
      }
    } catch {
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const related_suggestions = related.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  }).slice(0, 5);
  const knowledge_gaps = [];
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 2);
  if (memories.length === 0) {
    knowledge_gaps.push(
      `No memories match "${query}" \u2014 consider remember(project, key, value, "warning"|"pattern") to document this`
    );
  } else if (memories.length < 3 && terms.length >= 3) {
    knowledge_gaps.push(
      `Sparse coverage for a detailed query \u2014 review if "${query}" needs a dedicated memory`
    );
  }
  if (related_suggestions.length > 0 && memories.length > 0) {
    const unlinked = related_suggestions.filter((r) => r.relation === "semantic");
    if (unlinked.length >= 2) {
      knowledge_gaps.push(
        `Multiple semantically related keys not in results \u2014 consider linking with related=[] or compress()`
      );
    }
  }
  return { related_suggestions, knowledge_gaps };
}

// src/tools/memory.tools.ts
function registerMemoryTools(server2) {
  defineTool(
    server2,
    "recall",
    `Load project context: last session, memories, tasks, decisions.
WHEN: Need context mid-session without starting a new session.
NOT: At session start \u2014 use session_start instead (also opens session).
Example: recall("api", slim=true, fields=["tasks","decisions"])
Returns: Structured context. slim=true saves ~80% tokens (keys only).`,
    {
      project: z.string().describe("Project name"),
      slim: z.boolean().optional(),
      maxValueLength: z.number().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional()
    },
    ({ project, slim, maxValueLength, fields }) => fetchProjectContext(project, { slim, maxValueLength, fields })
  );
  defineTool(
    server2,
    "remember",
    `Save persistent knowledge that must survive this session.
WHEN: After discovering something non-obvious (bug cause, pattern, constraint).
NOT: For transient info (current file state, debug output).
Example: remember("api", "auth-gotcha", "JWT expires in 5m in dev", "warning")
Categories: rule > warning > pattern > preference > fact > note. Auto-embeds for search.`,
    {
      project: z.string(),
      key: z.string(),
      value: z.string(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).default("fact"),
      importance: z.number().min(1).max(10).optional(),
      expires_at: z.string().optional(),
      related: z.array(z.string()).optional(),
      agent: z.string().optional(),
      tool: z.string().optional()
    },
    async ({ project, key, value, category, importance, expires_at, related, agent, tool }) => {
      if (value.length > 1e4) return err("Value exceeds 10,000 character limit.");
      const prefix = key.split("-")[0];
      const similar = findSimilarKeys(project, key, prefix);
      const warnings = [];
      if (similar.length > 0) warnings.push(`Similar keys exist: ${similar.map((m) => `'${m.key}'`).join(", ")}. Consider updating one.`);
      if (value.length > 600) warnings.push(`Long value (${value.length} chars). If a full plan/spec, save as .md and reference the path.`);
      const autoImportance = importance ?? { rule: 9, warning: 8, pattern: 7, preference: 6, fact: 5, note: 5 }[category];
      const id = uuid();
      upsertMemory({ id, project, key, value, category, importance: autoImportance, tool: tool ?? "claude-code", agent: agent ?? null, expires_at: expires_at ?? null, related: related ?? [] });
      const saved = getByKey(project, key);
      if (saved) await embedMemory(saved.id);
      return withActions(
        { saved: true, project, key, category, importance: autoImportance, value, ...expires_at && { expires_at }, ...related?.length && { related }, ...warnings.length > 0 && { warnings } },
        rememberActions(warnings, similar.length)
      );
    }
  );
  defineTool(
    server2,
    "note",
    `Quick thought with auto-generated key. Shortcut for remember(category=note).
WHEN: Fast capture without choosing a key.
Example: note("api", "Stripe test mode uses sk_test_ prefix")
Returns: Auto key like note-stripe-test-mode-uses.`,
    { project: z.string(), text: z.string(), tool: z.string().optional() },
    async ({ project, text: noteText, tool }) => {
      const slug = noteText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
      const key = `note-${slug || Date.now()}`;
      const id = uuid();
      upsertMemory({ id, project, key, value: noteText, category: "note", importance: 5, tool: tool ?? "claude-code", agent: null, expires_at: null, related: [] });
      const saved = getByKey(project, key);
      if (saved) await embedMemory(saved.id);
      return withActions({ saved: true, project, key }, ["Use remember() with a descriptive key for important notes"]);
    }
  );
  defineTool(
    server2,
    "forget",
    `Delete a memory by key. Also removes vector embedding and graph links.
WHEN: Knowledge is outdated or wrong.
Example: forget("api", "old-auth-flow")
Returns: deleted:true or error if key not found.`,
    { project: z.string(), key: z.string() },
    ({ project, key }) => {
      const deleted = deleteByKey(project, key);
      if (!deleted) return err(`No memory found with key '${key}' in '${project}'`);
      return withActions({ deleted: true, project, key }, ["Run search() to confirm it's gone"]);
    }
  );
  defineTool(
    server2,
    "search",
    `Search memories (hybrid keyword+semantic), decisions, and/or tasks.
WHEN: Looking for existing knowledge before creating duplicates.
Example: search("api", "stripe webhook", mode="hybrid", scope=["memories","decisions"])
mode: keyword | semantic | hybrid (default). projects:["all"] for cross-project.`,
    {
      project: z.string(),
      query: z.string(),
      scope: z.array(z.enum(["memories", "decisions", "tasks"])).optional(),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
      projects: z.array(z.string()).optional(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional(),
      min_importance: z.number().min(1).max(10).optional()
    },
    async ({ project, query, scope, mode, projects, category, min_importance }) => {
      const searchIn = scope && scope.length > 0 ? scope : ["memories"];
      let targets;
      if (projects?.includes("all")) targets = Array.from(/* @__PURE__ */ new Set([project, ...allProjects()]));
      else if (projects?.length) targets = Array.from(/* @__PURE__ */ new Set([project, ...projects]));
      else targets = [project];
      const multi = targets.length > 1;
      const results = {};
      const filters = { category, minImportance: min_importance };
      let enrichment;
      if (searchIn.includes("memories")) {
        const rows = await searchMemories(query, targets, mode ?? "hybrid", 20, filters);
        results.memories = rows.map((m) => ({ ...multi && { project: m.project }, key: m.key, value: truncate(m.value, 600), category: m.category }));
        if (!multi && rows.length > 0) enrichment = enrichSearchResults(project, query, rows);
        else if (!multi && rows.length === 0) enrichment = enrichSearchResults(project, query, []);
      }
      if (searchIn.includes("decisions")) {
        results.decisions = search2(query, targets, 10).map((d) => ({ ...multi && { project: d.project }, topic: d.topic, choice: d.choice, reason: d.reason }));
      }
      if (searchIn.includes("tasks")) {
        results.tasks = search(query, targets, 10).map((t) => ({ ...multi && { project: t.project }, id: t.id, text: t.text, status: t.status, priority: t.priority }));
      }
      const total = Object.values(results).reduce((s, a) => s + a.length, 0);
      const actions = total === 0 ? ["No results \u2014 safe to create new knowledge with remember()"] : ["Review results before creating duplicates"];
      if (enrichment?.related_suggestions.length) {
        actions.push(`Related keys via graph: ${enrichment.related_suggestions.map((r) => r.key).join(", ")}`);
      }
      if (enrichment?.knowledge_gaps.length) {
        actions.push(...enrichment.knowledge_gaps);
      }
      return withActions(
        {
          project,
          searched_projects: targets,
          query,
          scope: searchIn,
          mode: mode ?? "hybrid",
          total_found: total,
          results,
          ...enrichment?.related_suggestions.length && { related_suggestions: enrichment.related_suggestions },
          ...enrichment?.knowledge_gaps.length && { knowledge_gaps: enrichment.knowledge_gaps }
        },
        actions
      );
    }
  );
}

// src/tools/work.tools.ts
import { z as z2 } from "zod";
function parseTags(s) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}
function registerWorkTools(server2) {
  defineTool(
    server2,
    "task",
    `Manage persistent backlog. actions: add | update | done | list | delete.
WHEN: Track work across sessions. done/update/delete accept UUID or 1-based position from list.
Example: task("api", "add", text="fix auth redirect", priority="high", tags=["auth"])
Position matches priority-sorted list (high first).`,
    {
      project: z2.string(),
      action: z2.enum(["add", "update", "done", "list", "delete"]),
      text: z2.string().optional(),
      id: z2.string().optional(),
      priority: z2.enum(["high", "medium", "low"]).optional().default("medium"),
      newText: z2.string().optional(),
      newPriority: z2.enum(["high", "medium", "low"]).optional(),
      tags: z2.array(z2.string()).optional(),
      newTags: z2.array(z2.string()).optional(),
      filter_tag: z2.string().optional(),
      tool: z2.string().optional()
    },
    ({ project, action, text: text3, id, priority, newText, newPriority, tags, newTags, filter_tag, tool }) => {
      if (action === "add") {
        if (!text3) return err("'text' is required for action=add");
        const newId = add(project, text3, priority ?? "medium", tags ?? [], tool ?? "claude-code");
        return withActions({ added: true, id: newId, text: text3, priority: priority ?? "medium", ...tags?.length && { tags } }, ["Use task list to see position for done/update"]);
      }
      if (action === "update") {
        if (!id) return err("'id' is required for action=update");
        if (!newText && !newPriority && !newTags) return err("'newText', 'newPriority', or 'newTags' required");
        const target = resolveId(project, id);
        if (!target) return err(`No task at position ${id} or ID not found.`);
        update(project, target, { text: newText, priority: newPriority, tags: newTags });
        return { updated: true, id: target, ...newText && { text: newText }, ...newPriority && { priority: newPriority }, ...newTags && { tags: newTags } };
      }
      if (action === "done" || action === "delete") {
        if (!id) return err(`'id' is required for action=${action}`);
        const target = resolveId(project, id);
        if (!target) return err(`No task at position ${id} or ID not found.`);
        if (action === "done") {
          markDone(project, target);
          const highPending = pending(project).filter((t) => t.priority === "high").length;
          return withActions({ done: true, id: target }, taskDoneActions(highPending));
        }
        remove(project, target);
        return { deleted: true, id: target };
      }
      const rows = all(project);
      let pending2 = rows.filter((t) => t.status === "pending");
      if (filter_tag) pending2 = pending2.filter((t) => parseTags(t.tags).includes(filter_tag));
      const pendingMapped = pending2.map((t, i) => ({ position: i + 1, id: t.id, text: t.text, priority: t.priority, ...parseTags(t.tags).length > 0 && { tags: parseTags(t.tags) } }));
      const done = rows.filter((t) => t.status === "done").map((t) => ({ id: t.id, text: t.text, done_at: t.done_at }));
      return { project, ...filter_tag && { filter_tag }, pending: pendingMapped, done };
    }
  );
  defineTool(
    server2,
    "decision",
    `Log an immutable technical/design decision. Never deleted \u2014 explains why code is the way it is.
WHEN: After choosing between alternatives (DB, auth, architecture).
Example: decision("api", "database", "PostgreSQL", "better Prisma support than MySQL")
Use supersedes to chain when a decision is replaced.`,
    {
      project: z2.string(),
      topic: z2.string(),
      choice: z2.string(),
      reason: z2.string(),
      tool: z2.string().optional(),
      supersedes: z2.string().optional().describe("ID of the decision this replaces")
    },
    ({ project, topic, choice, reason, tool, supersedes }) => {
      const id = add2(project, topic, choice, reason, tool ?? "claude-code", supersedes);
      return withActions({ logged: true, id, project, topic, choice, ...supersedes && { supersedes } }, ["Use list_decisions to review decision history"]);
    }
  );
  defineTool(
    server2,
    "list_decisions",
    `Full decision history with pagination. Decisions are immutable but chainable via supersedes.
WHEN: Need to understand past technical choices.
Example: list_decisions("api", limit=10)`,
    { project: z2.string(), limit: z2.number().optional().default(20), offset: z2.number().optional().default(0) },
    ({ project, limit, offset }) => {
      const { total, rows } = paginate(project, limit ?? 20, offset ?? 0);
      return {
        project,
        total,
        offset: offset ?? 0,
        limit: limit ?? 20,
        decisions: rows.map((d) => ({
          id: d.id,
          topic: d.topic,
          choice: d.choice,
          reason: d.reason,
          tool: d.tool,
          created_at: d.created_at,
          ...d.supersedes && { supersedes: d.supersedes }
        }))
      };
    }
  );
}

// src/tools/session.tools.ts
import { z as z3 } from "zod";

// src/repositories/project.repo.ts
function allProjectNames() {
  return db.prepare(
    `SELECT DISTINCT project FROM (
         SELECT project FROM memories UNION SELECT project FROM sessions
         UNION SELECT project FROM tasks UNION SELECT project FROM decisions
       )`
  ).all().map((r) => r.project);
}
function getStats(project) {
  const last = lastClosed(project);
  const c = (sql) => db.prepare(sql).get(project)?.c ?? 0;
  return {
    project,
    last_session: last ? { tool: last.tool, summary: truncate(last.summary ?? "", 150), ended_at: last.ended_at } : null,
    pending_tasks: c("SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'"),
    memories_count: c("SELECT COUNT(*) c FROM memories WHERE project = ?"),
    decisions_count: c("SELECT COUNT(*) c FROM decisions WHERE project = ?")
  };
}
function listWithStats() {
  const list = allProjectNames().map(getStats);
  list.sort((a, b) => {
    if (!a.last_session) return 1;
    if (!b.last_session) return -1;
    return new Date(b.last_session.ended_at).getTime() - new Date(a.last_session.ended_at).getTime();
  });
  return list;
}

// src/services/onboard.service.ts
function getOnboardProtocol() {
  return {
    ultron_version: "9.0.0",
    tagline: "Persistent developer memory \u2014 local SQLite, zero cloud, works with any MCP client",
    workflow: {
      step1: {
        action: "session_start",
        when: "At the START of every work session",
        example: 'session_start("my-project", "cursor", slim=true)',
        returns: "Last session, rules, warnings, pending tasks, decisions, snapshot"
      },
      step2: {
        action: "remember / task / decision / search",
        when: "DURING work \u2014 save non-obvious knowledge as you discover it",
        examples: [
          'remember("my-project", "auth-gotcha", "JWT expires in 5m in dev", "warning")',
          'decision("my-project", "database", "PostgreSQL", "better Prisma support")',
          'task("my-project", "add", "implement webhook retry", tags=["payments"])',
          'search("my-project", "stripe", mode="hybrid")'
        ]
      },
      step3: {
        action: "session_end",
        when: "At the END of every work session",
        example: 'session_end("my-project", "cursor", "finished PaymentForm", ["src/PaymentForm.tsx"])',
        returns: "Closes session + refreshes _snapshot for next session_start"
      }
    },
    categories: {
      rule: "Non-negotiable \u2014 always injected first on session_start",
      warning: "Things to AVOID \u2014 learned from real mistakes",
      pattern: "Architecture/code patterns to FOLLOW",
      preference: "Team style and conventions",
      fact: "Stack, URLs, versions, env var names",
      note: "Free-form observations"
    },
    key_conventions: [
      "Use kebab-case keys with topic prefix: auth-jwt-expiry, api-response-format",
      "Prefer updating an existing key over creating duplicates",
      "Long values (>600 chars): save as .md file, remember the path instead",
      "Use slim:true on session_start to save ~80% tokens on memories",
      'Use fields:["tasks"] to load only what you need',
      "Warnings and rules are highest priority \u2014 read them before coding"
    ],
    anti_patterns: [
      "Do NOT save transient info (current file contents, debug output)",
      "Do NOT duplicate keys \u2014 search first, then update",
      "Do NOT skip session_end \u2014 snapshot won't refresh",
      "Do NOT use positional task IDs without checking list order (priority-sorted)"
    ],
    tools_count: 25,
    tools_by_group: {
      memory: ["recall", "remember", "note", "forget", "search"],
      session: ["session_start", "session_end", "projects", "handoff", "onboard"],
      work: ["task", "decision", "list_decisions"],
      intelligence: ["health", "metrics", "graph", "compress", "generate_rules", "token_budget"],
      sync: ["export_project", "import_project"],
      agents: ["agent_register", "agent_log", "agent_handoff"]
    },
    token_tips: [
      "session_start(slim=true) \u2014 keys only, no values",
      'recall(fields=["tasks"]) \u2014 load subset',
      "token_budget(project) \u2014 check cost before full recall",
      "clean(project, action='list') \u2014 find stale memories to archive"
    ],
    agent_docs: "Full guide for AI agents: AGENTS.md in repo root (or read this onboard() response)",
    checklist: [
      "session_start(project, tool, slim=true)",
      "Read rules + warnings before coding",
      "search before remember (avoid duplicates)",
      "decision when choosing between alternatives",
      "session_end with summary + files"
    ]
  };
}

// src/tools/session.tools.ts
function parseJsonArray2(s) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}
function registerSessionTools(server2) {
  defineTool(
    server2,
    "session_start",
    `Start a work session AND load full project context in one call.
WHEN: At the START of every work session \u2014 always call this first.
Example: session_start("api", "cursor", slim=true)
Returns: session_id, rules (first), warnings, tasks, decisions, snapshot.
Token tip: slim=true saves ~80% tokens. fields=["tasks"] loads subset only.`,
    {
      project: z3.string(),
      tool: z3.string(),
      slim: z3.boolean().optional(),
      fields: z3.array(z3.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
      diff_since: z3.string().optional()
    },
    ({ project, tool, slim, fields, diff_since }) => {
      const purged = purgeExpired(project);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1e3).toISOString();
      const staleClosed = closeStale(project, twoHoursAgo);
      const sessionId = open(project, tool);
      const context = fetchProjectContext(project, { slim, fields, since: diff_since });
      return withActions(
        {
          session_id: sessionId,
          started_at: now(),
          ...purged > 0 && { auto_purged_expired: purged },
          ...staleClosed > 0 && { auto_closed_stale_sessions: staleClosed },
          ...context
        },
        sessionStartActions(context)
      );
    }
  );
  defineTool(
    server2,
    "session_end",
    `Close the active session with a summary. Refreshes _snapshot memory.
WHEN: At the END of every work session \u2014 never skip this.
Example: session_end("api", "cursor", "finished auth module", ["src/auth.ts"])
Returns: closed:true + snapshot_saved:true.`,
    { project: z3.string(), tool: z3.string(), summary: z3.string(), files: z3.array(z3.string()).optional() },
    async ({ project, tool, summary, files }) => {
      const open2 = findOpen(project, tool);
      if (!open2) return err(`No open session for '${project}' (${tool}). Use session_start first.`);
      close(open2.id, summary, files ?? []);
      const pendingTasks = topPending(project, 5);
      const topMemories = getRecentKeys(project, 8);
      const snapshot = [
        `Last session (${tool}): ${summary}`,
        files?.length ? `Files: ${files.slice(0, 5).join(", ")}` : null,
        pendingTasks.length ? `Pending tasks: ${pendingTasks.map((t) => `[${t.priority}] ${t.text}`).join(" | ")}` : "No pending tasks",
        topMemories.length ? `Key knowledge: ${topMemories.join(", ")}` : null
      ].filter(Boolean).join(" \u2014 ");
      const id = uuid();
      const savedId = saveSnapshot(project, snapshot, tool, id);
      await embedMemory(savedId);
      return withActions(
        { closed: true, project, tool, summary, snapshot_saved: true },
        ["Next session_start will load this snapshot automatically"]
      );
    }
  );
  defineTool(
    server2,
    "projects",
    `List all projects with stats: last session, pending tasks, memory + decision counts.
WHEN: Need overview of all projects or switching context.
Example: projects()
Returns: Sorted by most recent session.`,
    {},
    () => {
      const list = listWithStats();
      return withActions({ total: list.length, projects: list }, list.length > 1 ? ["Use session_start on the target project before working"] : []);
    }
  );
  defineTextTool(
    server2,
    "handoff",
    `Generate markdown context block for Claude.ai / ChatGPT (no MCP).
WHEN: Need to paste project context into a web chat.
Example: handoff("api")
Returns: Markdown block ready to paste.`,
    { project: z3.string() },
    ({ project }) => {
      const last = lastClosed(project);
      const memories = listForHandoff(project, 20);
      const tasks = pending(project);
      const decisions = recent(project, 8);
      const date = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
      let md = `## [ULTRON CONTEXT \u2014 ${project} \u2014 ${date}]

> Generated by ULTRON Hub v9. Paste at the start of your conversation.

`;
      if (last) {
        md += `### Last session (${last.tool})
${truncate(last.summary ?? "No summary", 500)}
`;
        const files = parseJsonArray2(last.files);
        if (files.length) md += `**Files:** ${files.join(", ")}
`;
        md += "\n";
      }
      if (memories.length) {
        const byCat = {};
        for (const m of memories) (byCat[m.category] ??= []).push(m);
        md += `### Project knowledge
`;
        for (const [cat, items] of Object.entries(byCat)) {
          md += `
**${cat[0].toUpperCase() + cat.slice(1)}:**
`;
          for (const m of items) md += `- **${m.key}**: ${truncate(m.value, 400)}
`;
        }
        md += "\n";
      }
      if (decisions.length) {
        md += `### Technical decisions
`;
        for (const d of decisions) md += `- **${d.topic}** \u2192 ${d.choice} \u2014 ${truncate(d.reason, 200)}
`;
        md += "\n";
      }
      if (tasks.length) {
        md += `### Pending tasks
`;
        for (const t of tasks) {
          const b = t.priority === "high" ? " [HIGH]" : t.priority === "low" ? " [LOW]" : "";
          md += `- [ ] ${t.text}${b}
`;
        }
        md += "\n";
      }
      md += `---
_ULTRON Hub v9_`;
      return md;
    }
  );
  defineTool(
    server2,
    "onboard",
    `Learn how to use ULTRON in one call. Returns the full protocol for any AI agent.
WHEN: First time using ULTRON, or unsure which tool to call.
Example: onboard()
Returns: Workflow, categories, conventions, anti-patterns, all 25 tools.`,
    {},
    () => withActions(getOnboardProtocol(), ["Call session_start(project, tool) to begin working"])
  );
}

// src/tools/maintenance.tools.ts
import { z as z4 } from "zod";
function registerMaintenanceTools(server2) {
  defineTool(
    server2,
    "clean",
    `List/archive/delete stale memories (not accessed in N+ days).
WHEN: Project memory is bloated or health reports stale entries.
Example: clean("api", action="list") then clean("api", action="archive")
actions: list (preview) | archive (delete all stale) | delete (single key).`,
    { project: z4.string(), action: z4.enum(["list", "archive", "delete"]).optional().default("list"), key: z4.string().optional(), days: z4.number().optional().default(45) },
    ({ project, action, key, days }) => {
      const threshold = days ?? 45;
      const act = action ?? "list";
      if (act === "delete") {
        if (!key) return err("'key' is required for action=delete");
        const deleted = deleteByKey(project, key);
        if (!deleted) return err(`No memory found with key '${key}'`);
        return withActions({ deleted: true, project, key }, ["Vector and graph links also removed"]);
      }
      const stale = getStaleMemories(project, threshold);
      if (act === "archive") {
        if (stale.length === 0) return { archived: 0, message: `No stale memories (threshold ${threshold}d)` };
        const keys = stale.map((m) => m.key);
        const count = deleteMemories(project, keys);
        return withActions({ archived: count, project, threshold_days: threshold, deleted_keys: keys }, ["Run health(project) to verify improvement"]);
      }
      return withActions({
        project,
        threshold_days: threshold,
        stale_count: stale.length,
        stale_memories: stale.map((m) => ({ key: m.key, category: m.category, last_accessed: m.last_accessed_at ?? "never", created_at: m.created_at, preview: truncate(m.value, 100) })),
        hint: stale.length > 0 ? `clean(project, action='archive') to delete all` : `Project is clean.`
      }, stale.length > 0 ? ["Review stale_memories before archiving"] : []);
    }
  );
}

// src/tools/intelligence.tools.ts
import { z as z5 } from "zod";

// src/lib/tokens.ts
function estimateTokens(text3) {
  return Math.ceil((text3?.length ?? 0) / 4);
}

// src/services/health.service.ts
function projectHealth(project) {
  const issues = [];
  const count = (sql, ...args) => db.prepare(sql).get(project, ...args)?.c ?? 0;
  const expired = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`);
  if (expired > 0) issues.push({ severity: "error", message: `${expired} expired memories still in DB`, action: "session_start() auto-purges them" });
  const neverAccessed = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND access_count = 0 AND created_at < datetime('now','-30 days') AND category != 'rule'`);
  if (neverAccessed > 3) issues.push({ severity: "warning", message: `${neverAccessed} memories never accessed in 30+ days`, action: "clean(project,'list') then forget()" });
  const snapshot = db.prepare(`SELECT updated_at FROM memories WHERE project = ? AND key = '_snapshot'`).get(project);
  const lastSession = db.prepare(`SELECT ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`).get(project);
  if (lastSession && !snapshot) issues.push({ severity: "warning", message: "No snapshot \u2014 session_end() never called", action: "Call session_end() when finishing" });
  else if (snapshot && lastSession) {
    const ageDays = (Date.now() - new Date(snapshot.updated_at).getTime()) / 864e5;
    if (ageDays > 7) issues.push({ severity: "info", message: `Snapshot is ${Math.round(ageDays)}d old`, action: "Call session_end() to refresh" });
  }
  const totalMemories = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`);
  const values = db.prepare(`SELECT value FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`).all(project);
  const estTokens = estimateTokens(values.map((v) => v.value).join(""));
  if (estTokens > 8e3) issues.push({ severity: "warning", message: `High token footprint: ~${estTokens} tokens across ${totalMemories} memories`, action: "Use slim:true or clean stale" });
  const prefixes = db.prepare(
    `SELECT SUBSTR(key,1,INSTR(key||'-','-')-1) prefix, COUNT(*) c FROM memories WHERE project = ? AND key != '_snapshot' GROUP BY prefix HAVING c >= 4`
  ).all(project);
  for (const p of prefixes) {
    const keys = db.prepare(
      `SELECT key FROM memories WHERE project = ? AND key LIKE ? AND key != '_snapshot' LIMIT 5`
    ).all(project, `${p.prefix}-%`);
    issues.push({
      severity: "info",
      message: `Prefix '${p.prefix}-' has ${p.c} memories \u2014 possible overlap`,
      action: `compress(project, keys=[${keys.map((k) => `'${k.key}'`).join(", ")}], new_key='${p.prefix}-summary', new_value='...')`
    });
  }
  if (isVecEnabled()) {
    const missingEmb = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND embedded_at IS NULL`);
    if (missingEmb > 0) issues.push({ severity: "info", message: `${missingEmb} memories without semantic embedding`, action: "runs automatically on save; backfill via daemon" });
  }
  const rules = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND category = 'rule'`);
  const pendingTasks = count(`SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'`);
  const score = Math.max(0, 100 - issues.filter((i) => i.severity === "error").length * 20 - issues.filter((i) => i.severity === "warning").length * 10 - issues.filter((i) => i.severity === "info").length * 5);
  return {
    project,
    health_score: score,
    status: score >= 80 ? "healthy" : score >= 50 ? "needs_attention" : "degraded",
    stats: { total_memories: totalMemories, rules, pending_tasks: pendingTasks, estimated_tokens: estTokens, expired_memories: expired },
    issues,
    ...issues.length === 0 && { message: "Project memory is clean and optimized." }
  };
}
function globalMetrics(project) {
  const where = project ? "WHERE project = ?" : "";
  const args = project ? [project] : [];
  const one = (sql) => db.prepare(sql).get(...args)?.c ?? 0;
  const memories = one(`SELECT COUNT(*) c FROM memories ${where}`);
  const sessions = one(`SELECT COUNT(*) c FROM sessions ${where}`);
  const decisions = one(`SELECT COUNT(*) c FROM decisions ${where}`);
  const tasks = one(`SELECT COUNT(*) c FROM tasks ${where}`);
  const embedded = one(`SELECT COUNT(*) c FROM memories ${where ? where + " AND" : "WHERE"} embedded_at IS NOT NULL`);
  const topAccessed = db.prepare(
    `SELECT project, key, access_count FROM memories ${where} ORDER BY access_count DESC LIMIT 10`
  ).all(...args);
  const agentRuns = db.prepare("SELECT COUNT(*) c FROM agent_runs").get().c;
  return {
    ...project && { project },
    counts: { memories, sessions, decisions, tasks, embedded, agent_runs: agentRuns },
    semantic_coverage: memories > 0 ? `${Math.round(embedded / memories * 100)}%` : "0%",
    vec_enabled: isVecEnabled(),
    top_accessed_memories: topAccessed
  };
}

// src/services/rules.service.ts
function generateRules(project, format, categories) {
  const cats = categories?.length ? categories : ["rule", "warning", "pattern", "preference"];
  const memories = getRulesMemories(project, cats);
  if (memories.length === 0) return `No memories in [${cats.join(", ")}] for '${project}'.`;
  const grouped = {};
  for (const m of memories) (grouped[m.category] ??= []).push(m);
  if (format === "cursor") return formatCursorRules(project, grouped);
  if (format === "agents") return formatAgentsMd(project, grouped);
  return formatClaudeMd(project, grouped);
}
function formatClaudeMd(project, grouped) {
  let md = `# Project Rules: ${project}
# Generated by ULTRON Hub v9

`;
  const section = (cat, title, comment, withKey = false) => {
    if (!grouped[cat]) return;
    md += `## ${title}
<!-- ${comment} -->

`;
    for (const m of grouped[cat]) md += withKey ? `- **${m.key}**: ${m.value}
` : `- ${m.value}
`;
    md += "\n";
  };
  section("rule", "Non-negotiable Rules", "Always active \u2014 injected first");
  section("warning", "Avoid", "Learned from real experience");
  section("pattern", "Follow", "Patterns that work in this project");
  section("preference", "Preferences", "Team conventions");
  section("fact", "Facts", "Key project data", true);
  md += `---
_Generated by ULTRON Hub v9 on ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}_
`;
  return md;
}
function formatCursorRules(project, grouped) {
  let out = `---
description: Project rules for ${project} (generated by ULTRON)
globs: **/*
alwaysApply: true
---

`;
  out += `# ${project} \u2014 ULTRON Rules

`;
  for (const [cat, items] of Object.entries(grouped)) {
    out += `## ${cat}

`;
    for (const m of items) out += `- ${cat === "fact" ? `**${m.key}**: ` : ""}${m.value}
`;
    out += "\n";
  }
  return out;
}
function formatAgentsMd(project, grouped) {
  let md = `# AGENTS.md \u2014 ${project}

> Generated by ULTRON Hub v9. Paste into project root for any AI agent.

`;
  md += `## Session protocol

1. Call \`session_start("${project}", "<tool>", slim=true)\`
`;
  md += `2. Save knowledge with \`remember\`, \`decision\`, \`task\`
`;
  md += `3. Close with \`session_end("${project}", "<tool>", summary, files)\`

`;
  for (const [cat, items] of Object.entries(grouped)) {
    md += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}

`;
    for (const m of items) md += `- ${m.value}
`;
    md += "\n";
  }
  return md;
}

// src/repositories/sync.repo.ts
var ULTRON_EXPORT_VERSION = "9.0.0";
function exportProject(project) {
  const t = (table) => db.prepare(`SELECT * FROM ${table} WHERE project = ?`).all(project);
  const memories = t("memories");
  const memoryIds = memories.map((m) => m.id);
  let memory_links = [];
  if (memoryIds.length > 0) {
    const ph = memoryIds.map(() => "?").join(",");
    memory_links = db.prepare(`SELECT * FROM memory_links WHERE from_id IN (${ph}) OR to_id IN (${ph})`).all(...memoryIds, ...memoryIds);
  }
  const agents = db.prepare("SELECT * FROM agents").all();
  const agent_runs = t("agent_runs");
  const sessions = t("sessions");
  const decisions = t("decisions");
  const tasks = t("tasks");
  return {
    ultron_version: ULTRON_EXPORT_VERSION,
    exported_at: now(),
    project,
    counts: {
      memories: memories.length,
      sessions: sessions.length,
      decisions: decisions.length,
      tasks: tasks.length,
      memory_links: memory_links.length,
      agents: agents.length,
      agent_runs: agent_runs.length
    },
    data: { memories, sessions, decisions, tasks, memory_links, agents, agent_runs }
  };
}
function importProject(payload, strategy) {
  const { project, data } = payload;
  const counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0, memory_links: 0, agents: 0, agent_runs: 0 };
  const tx = db.transaction(() => {
    if (strategy === "replace") {
      const memoryIds = db.prepare("SELECT id FROM memories WHERE project = ?").all(project).map((m) => m.id);
      if (memoryIds.length > 0) {
        const ph = memoryIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM memory_links WHERE from_id IN (${ph}) OR to_id IN (${ph})`).run(...memoryIds, ...memoryIds);
      }
      for (const t of ["memories", "sessions", "decisions", "tasks", "agent_runs"]) {
        db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
      }
    }
    const memStmt = db.prepare(
      `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, expires_at, last_accessed_at, access_count, related, created_at, updated_at, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project, key) DO UPDATE SET
         value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
         category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
         importance = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.importance ELSE memories.importance END,
         updated_at = MAX(excluded.updated_at, memories.updated_at),
         access_count = MAX(excluded.access_count, memories.access_count),
         embedded_at = NULL`
    );
    for (const m of data.memories ?? []) {
      const row = m;
      memStmt.run(
        row.id,
        row.project,
        row.key,
        row.value,
        row.category,
        row.importance ?? 5,
        row.tool,
        row.agent ?? null,
        row.expires_at,
        row.last_accessed_at,
        row.access_count ?? 0,
        typeof row.related === "string" ? row.related : JSON.stringify(row.related ?? []),
        row.created_at,
        row.updated_at
      );
      counts.memories++;
    }
    const sesStmt = db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of data.sessions ?? []) {
      const row = s;
      sesStmt.run(
        row.id,
        row.project,
        row.tool,
        row.summary,
        typeof row.files === "string" ? row.files : JSON.stringify(row.files ?? []),
        row.started_at,
        row.ended_at,
        row.created_at
      );
      counts.sessions++;
    }
    const decStmt = db.prepare(
      `INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, supersedes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of data.decisions ?? []) {
      const row = d;
      decStmt.run(row.id, row.project, row.topic, row.choice, row.reason, row.tool, row.supersedes ?? null, row.created_at);
      counts.decisions++;
    }
    const taskStmt = db.prepare(
      `INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tags, tool, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of data.tasks ?? []) {
      const row = t;
      taskStmt.run(
        row.id,
        row.project,
        row.text,
        row.status,
        row.priority,
        typeof row.tags === "string" ? row.tags : JSON.stringify(row.tags ?? []),
        row.tool,
        row.created_at,
        row.done_at
      );
      counts.tasks++;
    }
    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const l of data.memory_links ?? []) {
      const row = l;
      linkStmt.run(row.from_id, row.to_id, row.relation, row.weight ?? 1, row.created_at);
      counts.memory_links++;
    }
    const agentStmt = db.prepare(
      `INSERT INTO agents (id, name, type, capabilities, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
    );
    for (const a of data.agents ?? []) {
      const row = a;
      agentStmt.run(
        row.id,
        row.name,
        row.type,
        typeof row.capabilities === "string" ? row.capabilities : JSON.stringify(row.capabilities ?? []),
        row.registered_at
      );
      counts.agents++;
    }
    const runStmt = db.prepare(
      `INSERT OR IGNORE INTO agent_runs (id, agent, project, action, detail, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.agent_runs ?? []) {
      const row = r;
      runStmt.run(row.id, row.agent, row.project, row.action, row.detail, row.started_at, row.ended_at);
      counts.agent_runs++;
    }
    return counts;
  });
  return tx();
}
async function compressMemories(project, keys, newKey, newValue, newCategory) {
  const sources = db.prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${keys.map(() => "?").join(",")})`).all(project, ...keys);
  if (sources.length === 0) throw new Error(`No memories found for keys: ${keys.join(", ")}`);
  const maxImp = Math.max(...sources.map((m) => m.importance ?? 5));
  const allRelated = Array.from(
    new Set(
      sources.flatMap((m) => {
        try {
          return JSON.parse(m.related || "[]");
        } catch {
          return [];
        }
      }).filter((k) => !keys.includes(k))
    )
  );
  deleteMemories(project, keys);
  const id = uuid();
  upsertMemory({
    id,
    project,
    key: newKey,
    value: newValue,
    category: newCategory,
    importance: maxImp,
    tool: "claude-code",
    agent: null,
    expires_at: null,
    related: allRelated
  });
  const saved = getByKey(project, newKey);
  return { deletedKeys: sources.map((m) => m.key), newId: saved?.id ?? id, maxImportance: maxImp };
}

// src/tools/intelligence.tools.ts
function registerIntelligenceTools(server2) {
  defineTool(
    server2,
    "health",
    `Project integrity diagnostics \u2014 stale, expired, snapshot age, overlap, missing embeddings, token bloat.
WHEN: Before a big session or when recall feels slow.
Example: health("api") \u2192 health_score, issues with actionable fixes.`,
    { project: z5.string() },
    ({ project }) => {
      const h = projectHealth(project);
      return withActions(h, healthActions(h.health_score, h.issues.length));
    }
  );
  defineTool(
    server2,
    "metrics",
    `Usage + semantic-coverage metrics. Omit project for global view.
WHEN: Check embedding coverage or most-accessed memories.
Example: metrics("api") or metrics() for global.`,
    { project: z5.string().optional() },
    ({ project }) => globalMetrics(project)
  );
  defineTool(
    server2,
    "graph",
    `Knowledge graph around a memory key. BFS neighborhood up to depth hops.
WHEN: Explore related knowledge or find connections.
Example: graph("api", "auth-flow", depth=2, rebuild=true)
Edges: manual (from related) + semantic (embedding similarity).`,
    { project: z5.string(), key: z5.string(), depth: z5.number().optional().default(1), rebuild: z5.boolean().optional() },
    async ({ project, key, depth, rebuild }) => {
      if (rebuild) {
        rebuildManualLinks(project);
        await rebuildSemanticLinks(project);
      }
      return neighborhood(project, key, depth ?? 1);
    }
  );
  defineTool(
    server2,
    "compress",
    `Collapse multiple related memories into one structured memory.
WHEN: health reports prefix overlap or too many similar keys.
Example: compress("api", keys=["auth-jwt","auth-refresh"], new_key="auth-summary", new_value="...")
Use preview_only:true to review first.`,
    {
      project: z5.string(),
      keys: z5.array(z5.string()),
      new_key: z5.string(),
      new_value: z5.string(),
      new_category: z5.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional().default("fact"),
      preview_only: z5.boolean().optional()
    },
    async ({ project, keys, new_key, new_value, new_category, preview_only }) => {
      if (keys.length < 2) return err("compress requires at least 2 keys");
      const sources = getMemoriesByKeys(project, keys);
      if (sources.length === 0) return err(`No memories found for keys: ${keys.join(", ")}`);
      if (preview_only) return { preview: true, project, source_memories: sources, hint: "Re-run without preview_only to execute." };
      const result = await compressMemories(project, keys, new_key, new_value, new_category ?? "fact");
      await embedMemory(result.newId);
      return withActions({
        compressed: true,
        project,
        deleted_keys: result.deletedKeys,
        new_memory: { key: new_key, category: new_category ?? "fact", importance: result.maxImportance },
        tokens_saved_estimate: estimateTokens(sources.map((m) => m.value).join(""))
      }, ["Run search() to verify compressed memory is retrievable"]);
    }
  );
  defineTextTool(
    server2,
    "generate_rules",
    `Convert project memories into rules for AI tools.
WHEN: Generate CLAUDE.md, .cursor/rules, or AGENTS.md from stored knowledge.
Example: generate_rules("api", format="cursor")
format: claude (default) | cursor | agents`,
    {
      project: z5.string(),
      format: z5.enum(["claude", "cursor", "agents"]).optional().default("claude"),
      categories: z5.array(z5.enum(["rule", "warning", "pattern", "preference", "fact"])).optional()
    },
    ({ project, format, categories }) => generateRules(project, format ?? "claude", categories)
  );
  defineTool(
    server2,
    "token_budget",
    `Estimate tokens a full recall() would consume, with optimization suggestions.
WHEN: Recall feels expensive or project has many memories.
Example: token_budget("api") \u2192 total_estimated_tokens + suggestions.`,
    { project: z5.string() },
    ({ project }) => {
      const { memories, sessions, tasks, decisions, staleCount } = tokenBudgetRows(project);
      const sections = {
        memories: { count: memories.length, tokens: estimateTokens(JSON.stringify(memories)) },
        sessions: { count: sessions.length, tokens: estimateTokens(JSON.stringify(sessions)) },
        tasks: { count: tasks.length, tokens: estimateTokens(JSON.stringify(tasks)) },
        decisions: { count: decisions.length, tokens: estimateTokens(JSON.stringify(decisions)) }
      };
      const total = Object.values(sections).reduce((s, x) => s + x.tokens, 0);
      const suggestions = [];
      if (total > 5e3 && sections.memories.count > 15) suggestions.push("Use session_start slim:true (~80% memory token cut)");
      if (sections.tasks.count > 20) suggestions.push("Mark completed tasks done");
      if (staleCount > 5) suggestions.push(`${staleCount} stale memories \u2014 clean(project,'archive')`);
      if (total > 8e3) suggestions.push("Run health(project) for compression opportunities");
      return withActions(
        { project, total_estimated_tokens: total, sections, stale_memories: staleCount, ...suggestions.length && { suggestions }, ...total > 8e3 && { warning: `High token usage (${total}).` } },
        suggestions
      );
    }
  );
}

// src/tools/sync.tools.ts
import { z as z6 } from "zod";
function registerSyncTools(server2) {
  defineTool(
    server2,
    "export_project",
    `Export all project data as JSON (backup / cross-machine sync).
WHEN: Moving to another machine or creating a backup.
Example: export_project("api") \u2192 JSON with memories, tasks, decisions, links, agents.
Includes: memory_links, agents, agent_runs (v9+).`,
    { project: z6.string() },
    ({ project }) => {
      const payload = exportProject(project);
      return withActions(payload, ["Copy JSON output, then import_project on target machine"]);
    }
  );
  defineTool(
    server2,
    "import_project",
    `Import an exported JSON blob. strategy: merge (upsert newer) | replace (wipe then insert).
WHEN: Restoring backup or syncing from another machine.
Example: import_project('<json>', strategy="merge")
Post-import: embeddings are backfilled automatically.`,
    { data: z6.string(), strategy: z6.enum(["merge", "replace"]).optional().default("merge") },
    async ({ data: jsonStr, strategy }) => {
      let payload;
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        return err("Invalid JSON.");
      }
      if (!payload.project || !payload.data) return err("Invalid export format.");
      const counts = importProject(payload, strategy ?? "merge");
      const embedded = await backfillEmbeddings(64);
      return withActions(
        { imported: true, project: payload.project, strategy: strategy ?? "merge", counts, embeddings_backfilled: embedded },
        ["Call session_start to verify imported context"]
      );
    }
  );
}

// src/tools/agent.tools.ts
import { z as z7 } from "zod";

// src/repositories/agent.repo.ts
function registerAgent(name, type, capabilities) {
  db.prepare(
    `INSERT INTO agents (id, name, type, capabilities) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
  ).run(uuid(), name, type, JSON.stringify(capabilities));
}
function logRun(agent, action, project, detail) {
  const id = uuid();
  db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail) VALUES (?, ?, ?, ?, ?)").run(
    id,
    agent,
    project,
    action,
    detail
  );
  return id;
}
function endRun(runId, detail) {
  db.prepare("UPDATE agent_runs SET ended_at = ?, detail = COALESCE(?, detail) WHERE id = ?").run(
    now(),
    detail,
    runId
  );
}
async function handoff(project, fromAgent, toAgent, context) {
  const key = `handoff-${toAgent}`;
  const id = uuid();
  upsertMemory({
    id,
    project,
    key,
    value: `[from ${fromAgent} \u2192 ${toAgent}] ${context}`,
    category: "note",
    importance: 8,
    tool: "agent",
    agent: fromAgent,
    expires_at: null,
    related: []
  });
  const saved = getByKey(project, key);
  if (saved) await embedMemory(saved.id);
  return { key, id: saved?.id ?? id };
}

// src/tools/agent.tools.ts
function registerAgentTools(server2) {
  defineTool(
    server2,
    "agent_register",
    `Register an agent in the ULTRON ecosystem.
WHEN: A subagent or daemon starts working on a project.
Example: agent_register("ultron-architect", type="subagent", capabilities=["architecture"])
type: subagent (interactive) | daemon (background).`,
    { name: z7.string(), type: z7.enum(["subagent", "daemon"]).optional().default("subagent"), capabilities: z7.array(z7.string()).optional() },
    ({ name, type, capabilities }) => {
      registerAgent(name, type ?? "subagent", capabilities ?? []);
      return withActions({ registered: true, name, type: type ?? "subagent", capabilities: capabilities ?? [] }, ["Use agent_log to audit runs"]);
    }
  );
  defineTool(
    server2,
    "agent_log",
    `Record what an agent did \u2014 audit entry in agent_runs.
WHEN: Start/end of agent work, or significant milestones.
Example: agent_log("ultron-architect", "audit-complete", project="api", detail="score 71/100")
Use ended=true + run_id to close an open run.`,
    { agent: z7.string(), action: z7.string(), project: z7.string().optional(), detail: z7.string().optional(), run_id: z7.string().optional(), ended: z7.boolean().optional() },
    ({ agent, action, project, detail, run_id, ended }) => {
      if (run_id && ended) {
        endRun(run_id, detail ?? null);
        return { logged: true, run_id, ended: true };
      }
      const id = logRun(agent, action, project ?? null, detail ?? null);
      return { logged: true, run_id: id, agent, action };
    }
  );
  defineTool(
    server2,
    "agent_handoff",
    `One agent leaves structured context for another. Stored as high-importance memory.
WHEN: Subagent finishes and parent/other agent needs to continue.
Example: agent_handoff("api", from_agent="auditor", to_agent="implementer", context="Fix P0 vector cleanup first")
Receiving agent reads via recall/search for key handoff-{to_agent}.`,
    { project: z7.string(), from_agent: z7.string(), to_agent: z7.string(), context: z7.string() },
    async ({ project, from_agent, to_agent, context }) => {
      const { key } = await handoff(project, from_agent, to_agent, context);
      return withActions({ handed_off: true, project, from_agent, to_agent, key }, [`Agent ${to_agent} should search("${project}", "${key}") or recall()`]);
    }
  );
}

// src/tools/registry.ts
function registerAllTools(server2) {
  registerMemoryTools(server2);
  registerWorkTools(server2);
  registerSessionTools(server2);
  registerMaintenanceTools(server2);
  registerIntelligenceTools(server2);
  registerSyncTools(server2);
  registerAgentTools(server2);
}

// src/resources/registry.ts
import { readFileSync } from "fs";
import { join as join4, dirname } from "path";
import { fileURLToPath } from "url";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
var REPO_ROOT = join4(dirname(fileURLToPath(import.meta.url)), "../..");
function readDoc(name) {
  try {
    return readFileSync(join4(REPO_ROOT, name), "utf-8");
  } catch {
    return `# ${name} not found`;
  }
}
function registerAllResources(server2) {
  server2.registerResource(
    "projects",
    "ultron://projects",
    { mimeType: "application/json", description: "All projects with stats" },
    async () => ({
      contents: [{ uri: "ultron://projects", mimeType: "application/json", text: JSON.stringify(listWithStats(), null, 2) }]
    })
  );
  server2.registerResource(
    "project-context",
    new ResourceTemplate("ultron://{project}/context", { list: void 0 }),
    { mimeType: "application/json", description: "Full project context (slim)" },
    async (uri, variables) => {
      const project = variables.project;
      const ctx = fetchProjectContext(project, { slim: true });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx, null, 2) }]
      };
    }
  );
  server2.registerResource(
    "agent-guide",
    "ultron://agent-guide",
    { mimeType: "text/markdown", description: "AGENTS.md \u2014 instant protocol for AI agents" },
    async () => ({
      contents: [{ uri: "ultron://agent-guide", mimeType: "text/markdown", text: readDoc("AGENTS.md") }]
    })
  );
  server2.registerResource(
    "agent-example",
    "ultron://examples/session-workflow",
    { mimeType: "text/markdown", description: "Real-world 3-session workflow example" },
    async () => ({
      contents: [{ uri: "ultron://examples/session-workflow", mimeType: "text/markdown", text: readDoc("docs/examples/session-workflow.md") }]
    })
  );
  server2.registerResource(
    "project-rules",
    new ResourceTemplate("ultron://{project}/rules", { list: void 0 }),
    { mimeType: "application/json", description: "Project rules and warnings" },
    async (uri, variables) => {
      const project = variables.project;
      const rules = getRules(project);
      const warnings = getScoredMemories(project, 50).filter((m) => m.category === "warning");
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ project, rules, warnings }, null, 2)
        }]
      };
    }
  );
}

// src/prompts/registry.ts
import { z as z8 } from "zod";
function registerAllPrompts(server2) {
  server2.prompt(
    "start-session",
    "Guided workflow to start a ULTRON work session",
    { project: z8.string(), tool: z8.string() },
    ({ project, tool }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Start working on project "${project}" using tool "${tool}".

Follow this protocol:
1. Call session_start("${project}", "${tool}", slim=true)
2. Read rules and warnings FIRST before any code changes
3. Review pending_tasks and confirm priority with the user
4. During work: remember() for discoveries, decision() for choices, task() for backlog
5. At end: session_end("${project}", "${tool}", summary, files)

If unsure about ULTRON tools, call onboard() first.`
        }
      }]
    })
  );
  server2.prompt(
    "end-session",
    "Guided workflow to close a ULTRON work session",
    { project: z8.string(), tool: z8.string(), summary: z8.string() },
    ({ project, tool, summary }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Close the work session for "${project}".

1. Call session_end("${project}", "${tool}", "${summary}", [list of files touched])
2. Verify snapshot_saved: true in the response
3. If pending high-priority tasks remain, mention them to the user

Never skip session_end \u2014 the next session_start loads the snapshot.`
        }
      }]
    })
  );
  server2.prompt(
    "audit-memory",
    "Guided workflow to audit and optimize project memory",
    { project: z8.string() },
    ({ project }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Audit memory health for project "${project}".

1. Call health("${project}") \u2014 review health_score and issues
2. Call token_budget("${project}") \u2014 check token footprint
3. If stale memories found: clean("${project}", action="list") then archive if safe
4. If prefix overlap found: compress overlapping keys
5. Call generate_rules("${project}", format="claude") to export rules

Report findings and recommended actions to the user.`
        }
      }]
    })
  );
}

// src/cli/init.ts
import { existsSync, readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync3 } from "fs";
import { join as join5, dirname as dirname2 } from "path";
import { homedir as homedir4 } from "os";
import { fileURLToPath as fileURLToPath2 } from "url";
var ULTRON_ENTRY = fileURLToPath2(import.meta.url);
async function runInit() {
  const targets = [
    { name: "Claude Code (global)", path: join5(homedir4(), ".mcp.json") },
    { name: "Cursor (global)", path: join5(homedir4(), ".cursor", "mcp.json") }
  ];
  console.log("ULTRON Hub v9 \u2014 MCP init\n");
  console.log(`Server entry: ${ULTRON_ENTRY}
`);
  for (const target of targets) {
    try {
      const dir = dirname2(target.path);
      if (!existsSync(dir)) mkdirSync3(dir, { recursive: true });
      let config = {};
      if (existsSync(target.path)) {
        config = JSON.parse(readFileSync2(target.path, "utf-8"));
      }
      config.mcpServers ??= {};
      config.mcpServers.ultron = { command: "node", args: [ULTRON_ENTRY] };
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n");
      console.log(`\u2713 ${target.name}: ${target.path}`);
    } catch (e) {
      console.error(`\u2717 ${target.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("\nRestart Claude Code / Cursor to connect.");
  console.log('First call: onboard() or session_start("my-project", "cursor")');
}

// src/index.ts
var VERSION = "9.0.0";
if (process.argv.includes("init")) {
  await runInit();
  process.exit(0);
}
var server = new McpServer({ name: "ultron-hub", version: VERSION });
registerAllTools(server);
registerAllResources(server);
registerAllPrompts(server);
warmupEmbeddings();
var transport = new StdioServerTransport();
await server.connect(transport);
log.info(`ULTRON Hub v${VERSION} connected`);
