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
  return msg;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
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
    // value changed → embedding stale → force re-embed
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
function getRowid(id) {
  const r = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(id);
  return r?.rowid;
}
function deleteByKey(project, key) {
  const row = getByKey(project, key);
  if (!row) return void 0;
  db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
  return row;
}
function findSimilarKeys(project, key, prefix) {
  return db.prepare("SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?").all(project, key, `${prefix}-%`);
}
function purgeExpired(project) {
  return db.prepare(
    `DELETE FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).run(project).changes;
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
function ftsSearch(query, projects, limit = 20) {
  const ph = projects.map(() => "?").join(",");
  try {
    return db.prepare(
      `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE fts.memories_fts MATCH ? AND m.project IN (${ph})
         ORDER BY fts.rank LIMIT ?`
    ).all(query, ...projects, limit);
  } catch {
    return db.prepare(
      `SELECT * FROM memories WHERE project IN (${ph}) AND (key LIKE ? OR value LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`
    ).all(...projects, `%${query}%`, `%${query}%`, limit);
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
async function embedOne(text2) {
  const out = await embedMany([text2]);
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

// src/repositories/task.repo.ts
var PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END";
function pending(project) {
  return db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'pending' ORDER BY ${PRIORITY_ORDER}, created_at ASC`).all(project);
}
function all(project) {
  return db.prepare(`SELECT * FROM tasks WHERE project = ? ORDER BY ${PRIORITY_ORDER}, created_at ASC`).all(project);
}
function add(project, text2, priority, tags, tool) {
  const id = uuid();
  db.prepare("INSERT INTO tasks (id, project, text, priority, tags, tool) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    project,
    text2,
    priority,
    JSON.stringify(tags),
    tool
  );
  return id;
}
function resolveId(project, rawId) {
  const pos = parseInt(rawId, 10);
  if (!isNaN(pos) && String(pos) === rawId) {
    const list = db.prepare("SELECT id FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC").all(project);
    return list[pos - 1]?.id ?? null;
  }
  return rawId;
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

// src/repositories/decision.repo.ts
function add2(project, topic, choice, reason, tool) {
  const id = uuid();
  db.prepare("INSERT INTO decisions (id, project, topic, choice, reason, tool) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    project,
    topic,
    choice,
    reason,
    tool
  );
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
function search(query, projects, limit = 10) {
  const ph = projects.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM decisions WHERE project IN (${ph})
       AND (topic LIKE ? OR choice LIKE ? OR reason LIKE ?)
       ORDER BY created_at DESC LIMIT ?`
  ).all(...projects, `%${query}%`, `%${query}%`, `%${query}%`, limit);
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
async function searchMemories(query, projects, mode = "hybrid", limit = 20) {
  const useKeyword = mode === "keyword" || mode === "hybrid";
  const useSemantic = (mode === "semantic" || mode === "hybrid") && isVecEnabled();
  const keywordRows = useKeyword ? ftsSearch(query, projects, limit * 2) : [];
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

// src/tools/memory.tools.ts
function registerMemoryTools(server2) {
  server2.tool(
    "recall",
    `Load full project context: last session, memories, pending tasks, technical decisions.
Optional: slim (keys only, ~80% fewer tokens), maxValueLength, fields.`,
    {
      project: z.string().describe("Project name"),
      slim: z.boolean().optional(),
      maxValueLength: z.number().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional()
    },
    ({ project, slim, maxValueLength, fields }) => {
      try {
        return ok(fetchProjectContext(project, { slim, maxValueLength, fields }));
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "remember",
    `Save/update persistent knowledge. Categories: rule (always injected first), fact, pattern, preference, warning, note.
importance 1-10 controls ranking. Embeds for semantic search automatically.`,
    {
      project: z.string(),
      key: z.string(),
      value: z.string(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).default("fact"),
      importance: z.number().min(1).max(10).optional(),
      expires_at: z.string().optional(),
      related: z.array(z.string()).optional(),
      agent: z.string().optional().describe("Agent saving this (null = human/global)"),
      tool: z.string().optional()
    },
    async ({ project, key, value, category, importance, expires_at, related, agent, tool }) => {
      try {
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
        return ok({ saved: true, project, key, category, importance: autoImportance, value, ...expires_at && { expires_at }, ...related?.length && { related }, ...warnings.length > 0 && { warnings } });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "note",
    `Quick thought with auto-generated key. Shortcut for remember with category=note.`,
    { project: z.string(), text: z.string(), tool: z.string().optional() },
    async ({ project, text: noteText, tool }) => {
      try {
        const slug = noteText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
        const key = `note-${slug || Date.now()}`;
        const id = uuid();
        upsertMemory({ id, project, key, value: noteText, category: "note", importance: 5, tool: tool ?? "claude-code", agent: null, expires_at: null, related: [] });
        const saved = getByKey(project, key);
        if (saved) await embedMemory(saved.id);
        return ok({ saved: true, project, key });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "forget",
    `Delete a memory by key.`,
    { project: z.string(), key: z.string() },
    ({ project, key }) => {
      try {
        const rowid = (() => {
          const m = getByKey(project, key);
          return m ? getRowid(m.id) : void 0;
        })();
        const deleted = deleteByKey(project, key);
        if (!deleted) return err(`No memory found with key '${key}' in '${project}'`);
        if (rowid !== void 0) deleteVector(rowid);
        return ok({ deleted: true, project, key });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "search",
    `Search across memories (hybrid keyword+semantic), decisions, and/or tasks.
mode: "keyword" | "semantic" | "hybrid" (default hybrid). scope selects tables. projects:['all'] for cross-project.`,
    {
      project: z.string(),
      query: z.string(),
      scope: z.array(z.enum(["memories", "decisions", "tasks"])).optional(),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
      projects: z.array(z.string()).optional()
    },
    async ({ project, query, scope, mode, projects }) => {
      try {
        const searchIn = scope && scope.length > 0 ? scope : ["memories"];
        let targets;
        if (projects?.includes("all")) targets = Array.from(/* @__PURE__ */ new Set([project, ...allProjects()]));
        else if (projects?.length) targets = Array.from(/* @__PURE__ */ new Set([project, ...projects]));
        else targets = [project];
        const multi = targets.length > 1;
        const results = {};
        if (searchIn.includes("memories")) {
          const rows = await searchMemories(query, targets, mode ?? "hybrid", 20);
          results.memories = rows.map((m) => ({ ...multi && { project: m.project }, key: m.key, value: truncate(m.value, 600), category: m.category }));
        }
        if (searchIn.includes("decisions")) {
          results.decisions = search(query, targets, 10).map((d) => ({ ...multi && { project: d.project }, topic: d.topic, choice: d.choice, reason: d.reason }));
        }
        if (searchIn.includes("tasks")) {
          const ph = targets.map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT project, id, text, status, priority FROM tasks WHERE project IN (${ph}) AND text LIKE ? ORDER BY created_at DESC LIMIT 10`
          ).all(...targets, `%${query}%`);
          results.tasks = rows.map((t) => ({ ...multi && { project: t.project }, id: t.id, text: t.text, status: t.status, priority: t.priority }));
        }
        const total = Object.values(results).reduce((s, a) => s + a.length, 0);
        return ok({ project, searched_projects: targets, query, scope: searchIn, mode: mode ?? "hybrid", total_found: total, results });
      } catch (e) {
        return err(errOf(e));
      }
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
  server2.tool(
    "task",
    `Manage the persistent backlog. actions: add | update | done | list | delete.
done/update/delete accept a UUID or a 1-based position from recall/list.`,
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
    ({ project, action, text: text2, id, priority, newText, newPriority, tags, newTags, filter_tag, tool }) => {
      try {
        if (action === "add") {
          if (!text2) return err("'text' is required for action=add");
          const newId = add(project, text2, priority ?? "medium", tags ?? [], tool ?? "claude-code");
          return ok({ added: true, id: newId, text: text2, priority: priority ?? "medium", ...tags?.length && { tags } });
        }
        if (action === "update") {
          if (!id) return err("'id' is required for action=update");
          if (!newText && !newPriority && !newTags) return err("'newText', 'newPriority', or 'newTags' required");
          const target = resolveId(project, id);
          if (!target) return err(`No task at position ${id} or ID not found.`);
          update(project, target, { text: newText, priority: newPriority, tags: newTags });
          return ok({ updated: true, id: target, ...newText && { text: newText }, ...newPriority && { priority: newPriority }, ...newTags && { tags: newTags } });
        }
        if (action === "done" || action === "delete") {
          if (!id) return err(`'id' is required for action=${action}`);
          const target = resolveId(project, id);
          if (!target) return err(`No task at position ${id} or ID not found.`);
          if (action === "done") {
            markDone(project, target);
            return ok({ done: true, id: target });
          }
          remove(project, target);
          return ok({ deleted: true, id: target });
        }
        const rows = all(project);
        let pending2 = rows.filter((t) => t.status === "pending");
        if (filter_tag) pending2 = pending2.filter((t) => parseTags(t.tags).includes(filter_tag));
        const pendingMapped = pending2.map((t, i) => ({ position: i + 1, id: t.id, text: t.text, priority: t.priority, ...parseTags(t.tags).length > 0 && { tags: parseTags(t.tags) } }));
        const done = rows.filter((t) => t.status === "done").map((t) => ({ id: t.id, text: t.text, done_at: t.done_at }));
        return ok({ project, ...filter_tag && { filter_tag }, pending: pendingMapped, done });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "decision",
    `Log an immutable technical/design decision \u2014 never deleted. Explains why the code is the way it is.`,
    { project: z2.string(), topic: z2.string(), choice: z2.string(), reason: z2.string(), tool: z2.string().optional() },
    ({ project, topic, choice, reason, tool }) => {
      try {
        const id = add2(project, topic, choice, reason, tool ?? "claude-code");
        return ok({ logged: true, id, project, topic, choice });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "list_decisions",
    `Full decision history with pagination. Decisions are immutable.`,
    { project: z2.string(), limit: z2.number().optional().default(20), offset: z2.number().optional().default(0) },
    ({ project, limit, offset }) => {
      try {
        const { total, rows } = paginate(project, limit ?? 20, offset ?? 0);
        return ok({ project, total, offset: offset ?? 0, limit: limit ?? 20, decisions: rows.map((d) => ({ topic: d.topic, choice: d.choice, reason: d.reason, tool: d.tool, created_at: d.created_at })) });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
}

// src/tools/session.tools.ts
import { z as z3 } from "zod";
function registerSessionTools(server2) {
  server2.tool(
    "session_start",
    `Start a work session AND load full project context (session_start + recall in one).
Rules always injected first. Memories relevance-ranked. Expired auto-purged.
Token control: slim, fields, diff_since.`,
    {
      project: z3.string(),
      tool: z3.string(),
      slim: z3.boolean().optional(),
      fields: z3.array(z3.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
      diff_since: z3.string().optional()
    },
    ({ project, tool, slim, fields, diff_since }) => {
      try {
        const purged = purgeExpired(project);
        const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1e3).toISOString();
        const staleClosed = closeStale(project, twoHoursAgo);
        const sessionId = open(project, tool);
        const context = fetchProjectContext(project, { slim, fields, since: diff_since });
        return ok({
          session_id: sessionId,
          started_at: now(),
          ...purged > 0 && { auto_purged_expired: purged },
          ...staleClosed > 0 && { auto_closed_stale_sessions: staleClosed },
          ...context
        });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "session_end",
    `Close the active session with a summary. Records work + files and refreshes the _snapshot memory.`,
    { project: z3.string(), tool: z3.string(), summary: z3.string(), files: z3.array(z3.string()).optional() },
    ({ project, tool, summary, files }) => {
      try {
        const open2 = findOpen(project, tool);
        if (!open2) return ok({ closed: false, warning: `No open session for '${project}' (${tool}). Use session_start first.`, project, tool });
        close(open2.id, summary, files ?? []);
        const pendingTasks = topPending(project, 5);
        const topMemories = db.prepare("SELECT key FROM memories WHERE project = ? AND key != '_snapshot' ORDER BY updated_at DESC LIMIT 8").all(project);
        const snapshot = [
          `Last session (${tool}): ${summary}`,
          files?.length ? `Files: ${files.slice(0, 5).join(", ")}` : null,
          pendingTasks.length ? `Pending tasks: ${pendingTasks.map((t) => `[${t.priority}] ${t.text}`).join(" | ")}` : "No pending tasks",
          topMemories.length ? `Key knowledge: ${topMemories.map((m) => m.key).join(", ")}` : null
        ].filter(Boolean).join(" \u2014 ");
        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, tool, updated_at)
           VALUES (?, ?, '_snapshot', ?, 'note', ?, datetime('now'))
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, tool = excluded.tool, updated_at = excluded.updated_at`
        ).run(uuid(), project, snapshot, tool);
        return ok({ closed: true, project, tool, summary, snapshot_saved: true });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "projects",
    `List all projects with stats: last session, pending tasks, memory + decision counts.`,
    {},
    () => {
      try {
        const rows = db.prepare(
          `SELECT DISTINCT project FROM (SELECT project FROM memories UNION SELECT project FROM sessions UNION SELECT project FROM tasks UNION SELECT project FROM decisions)`
        ).all();
        const list = rows.map(({ project: p }) => {
          const last = lastClosed(p);
          const c = (sql) => db.prepare(sql).get(p)?.c ?? 0;
          return {
            project: p,
            last_session: last ? { tool: last.tool, summary: truncate(last.summary ?? "", 150), ended_at: last.ended_at } : null,
            pending_tasks: c("SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'"),
            memories_count: c("SELECT COUNT(*) c FROM memories WHERE project = ?"),
            decisions_count: c("SELECT COUNT(*) c FROM decisions WHERE project = ?")
          };
        });
        list.sort((a, b) => {
          if (!a.last_session) return 1;
          if (!b.last_session) return -1;
          return new Date(b.last_session.ended_at).getTime() - new Date(a.last_session.ended_at).getTime();
        });
        return ok({ total: list.length, projects: list });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "handoff",
    `Generate a markdown context block to paste into Claude.ai / ChatGPT (no MCP).`,
    { project: z3.string() },
    ({ project }) => {
      try {
        const last = lastClosed(project);
        const memories = db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 20").all(project);
        const tasks = pending(project);
        const decisions = recent(project, 8);
        const date = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
        let md = `## [ULTRON CONTEXT \u2014 ${project} \u2014 ${date}]

> Generated by ULTRON Hub v8. Paste at the start of your conversation.

`;
        if (last) {
          md += `### Last session (${last.tool})
${truncate(last.summary ?? "No summary", 500)}
`;
          const files = (() => {
            try {
              return JSON.parse(last.files || "[]");
            } catch {
              return [];
            }
          })();
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
_ULTRON Hub v8_`;
        return text(md);
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
}

// src/tools/maintenance.tools.ts
import { z as z4 } from "zod";

// src/lib/tokens.ts
function estimateTokens(text2) {
  return Math.ceil((text2?.length ?? 0) / 4);
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
  for (const p of prefixes) issues.push({ severity: "info", message: `Prefix '${p.prefix}-' has ${p.c} memories \u2014 possible overlap`, action: `compress(project, prefix='${p.prefix}')` });
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

// src/tools/maintenance.tools.ts
function registerMaintenanceTools(server2) {
  server2.tool(
    "clean",
    `List/archive stale memories (not accessed in N+ days). actions: list | archive | delete.`,
    { project: z4.string(), action: z4.enum(["list", "archive", "delete"]).optional().default("list"), key: z4.string().optional(), days: z4.number().optional().default(45) },
    ({ project, action, key, days }) => {
      try {
        const threshold = days ?? 45;
        const act = action ?? "list";
        if (act === "delete") {
          if (!key) return err("'key' is required for action=delete");
          const r = db.prepare("DELETE FROM memories WHERE project = ? AND key = ?").run(project, key);
          if (r.changes === 0) return err(`No memory found with key '${key}'`);
          return ok({ deleted: true, project, key });
        }
        const stale = db.prepare(
          `SELECT key, category, value, last_accessed_at, created_at FROM memories
           WHERE project = ? AND key != '_snapshot'
             AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-' || ? || ' days'))
           ORDER BY last_accessed_at ASC NULLS FIRST`
        ).all(project, threshold);
        if (act === "archive") {
          if (stale.length === 0) return ok({ archived: 0, message: `No stale memories (threshold ${threshold}d)` });
          const keys = stale.map((m) => m.key);
          const ph = keys.map(() => "?").join(",");
          db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${ph})`).run(project, ...keys);
          return ok({ archived: stale.length, project, threshold_days: threshold, deleted_keys: keys });
        }
        return ok({
          project,
          threshold_days: threshold,
          stale_count: stale.length,
          stale_memories: stale.map((m) => ({ key: m.key, category: m.category, last_accessed: m.last_accessed_at ?? "never", created_at: m.created_at, preview: truncate(m.value, 100) })),
          hint: stale.length > 0 ? `clean(project, action='archive') to delete all` : `Project is clean.`
        });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "health",
    `Project integrity diagnostics \u2014 actionable warnings (stale, expired, snapshot age, overlap, missing embeddings, token bloat).`,
    { project: z4.string() },
    ({ project }) => {
      try {
        return ok(projectHealth(project));
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "metrics",
    `Usage + semantic-coverage metrics. Omit project for global view.`,
    { project: z4.string().optional() },
    ({ project }) => {
      try {
        return ok(globalMetrics(project));
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "graph",
    `Knowledge graph around a memory key. Returns the BFS neighborhood (nodes + edges) up to depth hops.
Edges are manual (from related) + semantic (embedding similarity). rebuild=true recomputes edges first.`,
    { project: z4.string(), key: z4.string(), depth: z4.number().optional().default(1), rebuild: z4.boolean().optional() },
    async ({ project, key, depth, rebuild }) => {
      try {
        if (rebuild) {
          rebuildManualLinks(project);
          await rebuildSemanticLinks(project);
        }
        return ok(neighborhood(project, key, depth ?? 1));
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "compress",
    `Collapse multiple related memories into one structured memory. preview_only:true to review first.`,
    { project: z4.string(), keys: z4.array(z4.string()), new_key: z4.string(), new_value: z4.string(), new_category: z4.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional().default("fact"), preview_only: z4.boolean().optional() },
    async ({ project, keys, new_key, new_value, new_category, preview_only }) => {
      try {
        if (keys.length < 2) return err("compress requires at least 2 keys");
        const ph = keys.map(() => "?").join(",");
        const sources = db.prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${ph})`).all(project, ...keys);
        if (sources.length === 0) return err(`No memories found for keys: ${keys.join(", ")}`);
        if (preview_only) return ok({ preview: true, project, source_memories: sources.map((m) => ({ key: m.key, category: m.category, importance: m.importance, value: m.value })), hint: "Re-run without preview_only to execute." });
        const maxImp = Math.max(...sources.map((m) => m.importance ?? 5));
        const allRelated = Array.from(new Set(sources.flatMap((m) => {
          try {
            return JSON.parse(m.related || "[]");
          } catch {
            return [];
          }
        }).filter((k) => !keys.includes(k))));
        db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${ph})`).run(project, ...keys);
        const id = uuid();
        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, importance, related, tool, updated_at, embedded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code', datetime('now'), NULL)
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, category = excluded.category, importance = excluded.importance, related = excluded.related, updated_at = excluded.updated_at, embedded_at = NULL`
        ).run(id, project, new_key, new_value, new_category ?? "fact", maxImp, JSON.stringify(allRelated));
        const saved = db.prepare("SELECT id FROM memories WHERE project = ? AND key = ?").get(project, new_key);
        if (saved) await embedMemory(saved.id);
        return ok({ compressed: true, project, deleted_keys: sources.map((m) => m.key), new_memory: { key: new_key, category: new_category ?? "fact", importance: maxImp }, tokens_saved_estimate: estimateTokens(sources.map((m) => m.value).join("")) });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "generate_rules",
    `Convert project memories into CLAUDE.md-ready markdown rules.`,
    { project: z4.string(), categories: z4.array(z4.enum(["rule", "warning", "pattern", "preference", "fact"])).optional() },
    ({ project, categories }) => {
      try {
        const cats = categories?.length ? categories : ["rule", "warning", "pattern", "preference"];
        const ph = cats.map(() => "?").join(",");
        const memories = db.prepare(
          `SELECT key, value, category FROM memories WHERE project = ? AND category IN (${ph}) AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY CASE category WHEN 'rule' THEN 0 WHEN 'warning' THEN 1 WHEN 'pattern' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END, importance DESC, key`
        ).all(project, ...cats);
        if (memories.length === 0) return text(`No memories in [${cats.join(", ")}] for '${project}'.`);
        const grouped = {};
        for (const m of memories) (grouped[m.category] ??= []).push(m);
        let md = `# Project Rules: ${project}
# Generated by ULTRON Hub v8

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
_Generated by ULTRON Hub v8 on ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}_
`;
        return text(md);
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "token_budget",
    `Estimate tokens a full recall() would consume, with optimization suggestions.`,
    { project: z4.string() },
    ({ project }) => {
      try {
        const memories = db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30").all(project);
        const sessions = db.prepare("SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5").all(project);
        const tasks = db.prepare("SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'").all(project);
        const decisions = db.prepare("SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10").all(project);
        const staleCount = db.prepare(`SELECT COUNT(*) c FROM memories WHERE project = ? AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-45 days'))`).get(project).c;
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
        return ok({ project, total_estimated_tokens: total, sections, stale_memories: staleCount, ...suggestions.length && { suggestions }, ...total > 8e3 && { warning: `High token usage (${total}).` } });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "export_project",
    `Export all data for a project as JSON (backup / cross-machine sync).`,
    { project: z4.string() },
    ({ project }) => {
      try {
        const t = (n) => db.prepare(`SELECT * FROM ${n} WHERE project = ?`).all(project);
        const memories = t("memories"), sessions = t("sessions"), decisions = t("decisions"), tasks = t("tasks");
        return ok({ ultron_version: "8.0.0", exported_at: now(), project, counts: { memories: memories.length, sessions: sessions.length, decisions: decisions.length, tasks: tasks.length }, data: { memories, sessions, decisions, tasks } });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "import_project",
    `Import an exported JSON blob. strategy: merge (upsert keeping newer) | replace (wipe then insert).`,
    { data: z4.string(), strategy: z4.enum(["merge", "replace"]).optional().default("merge") },
    ({ data: jsonStr, strategy }) => {
      try {
        const payload = JSON.parse(jsonStr);
        if (!payload.project || !payload.data) return err("Invalid export format.");
        const { project, data } = payload;
        const strat = strategy ?? "merge";
        const tx = db.transaction(() => {
          const counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0 };
          if (strat === "replace") for (const t of ["memories", "sessions", "decisions", "tasks"]) db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
          const memStmt = db.prepare(
            `INSERT INTO memories (id, project, key, value, category, importance, tool, expires_at, last_accessed_at, access_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (project, key) DO UPDATE SET
               value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
               category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
               importance = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.importance ELSE memories.importance END,
               updated_at = MAX(excluded.updated_at, memories.updated_at),
               access_count = MAX(excluded.access_count, memories.access_count),
               embedded_at = NULL`
          );
          for (const m of data.memories ?? []) {
            memStmt.run(m.id, m.project, m.key, m.value, m.category, m.importance ?? 5, m.tool, m.expires_at, m.last_accessed_at, m.access_count ?? 0, m.created_at, m.updated_at);
            counts.memories++;
          }
          const sesStmt = db.prepare(`INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const s of data.sessions ?? []) {
            sesStmt.run(s.id, s.project, s.tool, s.summary, typeof s.files === "string" ? s.files : JSON.stringify(s.files ?? []), s.started_at, s.ended_at, s.created_at);
            counts.sessions++;
          }
          const decStmt = db.prepare(`INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const d of data.decisions ?? []) {
            decStmt.run(d.id, d.project, d.topic, d.choice, d.reason, d.tool, d.created_at);
            counts.decisions++;
          }
          const taskStmt = db.prepare(`INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tool, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const t of data.tasks ?? []) {
            taskStmt.run(t.id, t.project, t.text, t.status, t.priority, t.tool, t.created_at, t.done_at);
            counts.tasks++;
          }
          return counts;
        });
        return ok({ imported: true, project, strategy: strat, counts: tx() });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
}

// src/tools/agent.tools.ts
import { z as z5 } from "zod";
function registerAgentTools(server2) {
  server2.tool(
    "agent_register",
    `Register an agent in the ULTRON ecosystem. type: subagent (interactive) | daemon (background).`,
    { name: z5.string(), type: z5.enum(["subagent", "daemon"]).optional().default("subagent"), capabilities: z5.array(z5.string()).optional() },
    ({ name, type, capabilities }) => {
      try {
        db.prepare(
          `INSERT INTO agents (id, name, type, capabilities) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
        ).run(uuid(), name, type ?? "subagent", JSON.stringify(capabilities ?? []));
        return ok({ registered: true, name, type: type ?? "subagent", capabilities: capabilities ?? [] });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "agent_log",
    `Record what an agent did \u2014 an audit entry in agent_runs. Use ended=true to close an open run.`,
    { agent: z5.string(), action: z5.string(), project: z5.string().optional(), detail: z5.string().optional(), run_id: z5.string().optional(), ended: z5.boolean().optional() },
    ({ agent, action, project, detail, run_id, ended }) => {
      try {
        if (run_id && ended) {
          db.prepare("UPDATE agent_runs SET ended_at = ?, detail = COALESCE(?, detail) WHERE id = ?").run(now(), detail ?? null, run_id);
          return ok({ logged: true, run_id, ended: true });
        }
        const id = uuid();
        db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail) VALUES (?, ?, ?, ?, ?)").run(id, agent, project ?? null, action, detail ?? null);
        return ok({ logged: true, run_id: id, agent, action });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
  server2.tool(
    "agent_handoff",
    `One agent leaves structured context for another. Stored as a high-importance memory keyed by target agent.
The receiving agent reads it via recall/search. Enables shared memory across the agent ecosystem.`,
    { project: z5.string(), from_agent: z5.string(), to_agent: z5.string(), context: z5.string() },
    ({ project, from_agent, to_agent, context }) => {
      try {
        const key = `handoff-${to_agent}`;
        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, updated_at, embedded_at)
           VALUES (?, ?, ?, ?, 'note', 8, 'agent', ?, datetime('now'), NULL)
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, agent = excluded.agent, updated_at = excluded.updated_at, embedded_at = NULL`
        ).run(uuid(), project, key, `[from ${from_agent} \u2192 ${to_agent}] ${context}`, from_agent);
        return ok({ handed_off: true, project, from_agent, to_agent, key });
      } catch (e) {
        return err(errOf(e));
      }
    }
  );
}

// src/tools/registry.ts
function registerAllTools(server2) {
  registerMemoryTools(server2);
  registerWorkTools(server2);
  registerSessionTools(server2);
  registerMaintenanceTools(server2);
  registerAgentTools(server2);
}

// src/index.ts
var server = new McpServer({ name: "ultron-hub", version: "8.0.0" });
registerAllTools(server);
var transport = new StdioServerTransport();
await server.connect(transport);
log.info("ULTRON Hub v8 connected");
