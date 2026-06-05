#!/usr/bin/env node

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
      for (const { canonical, all } of groups.values()) {
        const variants = all.filter((p) => p !== canonical);
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
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;
  const tx = db2.transaction(() => {
    for (const m of pending) {
      log.info("running migration", { version: m.version, name: m.name });
      m.up(db2);
      db2.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(
        String(m.version)
      );
    }
  });
  tx();
  log.info("migrations complete", { from: current, to: pending[pending.length - 1].version });
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

// src/lib/tokens.ts
function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

// src/services/health.service.ts
function projectHealth(project) {
  const issues = [];
  const count = (sql, ...args2) => db.prepare(sql).get(project, ...args2)?.c ?? 0;
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
async function embedOne(text) {
  const out = await embedMany([text]);
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
async function backfillEmbeddings(batchSize = 32) {
  if (!isVecEnabled()) return 0;
  const pending = db.prepare("SELECT rowid, id, key, value FROM memories WHERE embedded_at IS NULL").all();
  let done = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
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
    log.info("embedding backfill progress", { done, total: pending.length });
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

// src/daemon/tasks.ts
var AGENT = "ultron-daemon";
function logRun(action, project, detail) {
  db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(
    uuid(),
    AGENT,
    project,
    action,
    detail
  );
}
function allProjects() {
  return db.prepare(
    `SELECT DISTINCT project FROM (SELECT project FROM memories UNION SELECT project FROM tasks)`
  ).all().map((r) => r.project);
}
function nightlyCurator(dryRun2) {
  const projects = allProjects();
  const report = { projects: projects.length, dryRun: dryRun2 };
  let purged = 0;
  for (const p of projects) {
    if (!dryRun2) {
      purged += db.prepare(
        `DELETE FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
      ).run(p).changes;
    }
  }
  report.purged_expired = purged;
  const degraded = projects.map((p) => projectHealth(p)).filter((h) => h.health_score < 80).map((h) => ({ project: h.project, score: h.health_score, status: h.status }));
  report.needs_attention = degraded;
  if (!dryRun2) {
    const wc = db.pragma("wal_checkpoint(TRUNCATE)");
    report.wal_checkpoint = wc;
    logRun("nightly-curator", null, `purged=${purged} degraded=${degraded.length}`);
  }
  return report;
}
async function memoryGardener(dryRun2) {
  const report = { dryRun: dryRun2, vec_enabled: isVecEnabled() };
  if (!isVecEnabled()) {
    report.skipped = "sqlite-vec unavailable";
    return report;
  }
  const missing = db.prepare("SELECT COUNT(*) c FROM memories WHERE embedded_at IS NULL").get().c;
  report.embeddings_missing = missing;
  if (!dryRun2 && missing > 0) {
    report.embedded = await backfillEmbeddings(64);
  }
  if (!dryRun2) {
    let manual = 0, semantic = 0;
    for (const p of allProjects()) {
      manual += rebuildManualLinks(p);
      semantic += await rebuildSemanticLinks(p);
    }
    report.links = { manual, semantic };
    logRun("memory-gardener", null, `embedded_missing=${missing} links_manual=${manual} links_semantic=${semantic}`);
  }
  return report;
}
async function runAll(dryRun2) {
  log.info("daemon run start", { dryRun: dryRun2 });
  const nc = nightlyCurator(dryRun2);
  log.info("nightly-curator done", nc);
  const mg = await memoryGardener(dryRun2);
  log.info("memory-gardener done", mg);
  console.error("[ultron-daemon]", JSON.stringify({ nightlyCurator: nc, memoryGardener: mg }, null, 2));
}

// src/daemon/index.ts
var args = new Set(process.argv.slice(2));
var dryRun = args.has("--dry") || args.has("--dry-run");
var once = args.has("--once");
var INTERVAL_MS = Number(process.env.ULTRON_DAEMON_INTERVAL_MS ?? 6 * 3600 * 1e3);
async function main() {
  if (once) {
    await runAll(dryRun);
    process.exit(0);
  }
  log.info("ultron-daemon started (loop)", { intervalMs: INTERVAL_MS, dryRun });
  await runAll(dryRun);
  setInterval(() => {
    void runAll(dryRun);
  }, INTERVAL_MS);
}
main().catch((e) => {
  log.error("daemon fatal", { error: String(e) });
  process.exit(1);
});
