// ── ULTRON v8 — versioned, idempotent migrations ──────────────────────────────
// Replaces the old try/catch ALTER + conditional DROP TABLE. Each migration runs
// once, in order, guarded by _meta.schema_version. Idempotent: safe to re-run.

import type { Database as DatabaseType } from "better-sqlite3";
import { log } from "../lib/logger.js";

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

/** Add a column only if it does not already exist (idempotent). */
function addColumnIfMissing(db: DatabaseType, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 8,
    name: "v7-to-v8: agent + embedding columns",
    up: (db) => {
      addColumnIfMissing(db, "memories", "agent", "agent TEXT");
      addColumnIfMissing(db, "memories", "embedded_at", "embedded_at TEXT");
      addColumnIfMissing(db, "memories", "related", "related TEXT DEFAULT '[]'");
      addColumnIfMissing(db, "memories", "access_count", "access_count INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "memories", "importance", "importance INTEGER NOT NULL DEFAULT 5");
      addColumnIfMissing(db, "tasks", "tags", "tags TEXT DEFAULT '[]'");
    },
  },
  {
    version: 9,
    name: "normalize project names (merge case duplicates)",
    up: (db) => {
      // Map every project string to its canonical lowercased+trimmed form, then
      // pick the most-used original casing as canonical to preserve readability.
      const rows = db
        .prepare(
          `SELECT project, COUNT(*) c FROM (
             SELECT project FROM memories UNION ALL
             SELECT project FROM sessions UNION ALL
             SELECT project FROM tasks UNION ALL
             SELECT project FROM decisions
           ) GROUP BY project`
        )
        .all() as Array<{ project: string; c: number }>;

      // group by normalized key, choose canonical = highest count
      const groups = new Map<string, { canonical: string; max: number; all: string[] }>();
      for (const r of rows) {
        const norm = r.project.trim().toLowerCase();
        const g = groups.get(norm);
        if (!g) {
          groups.set(norm, { canonical: r.project, max: r.c, all: [r.project] });
        } else {
          g.all.push(r.project);
          if (r.c > g.max) { g.max = r.c; g.canonical = r.project; }
        }
      }

      const tables = ["memories", "sessions", "tasks", "decisions", "agent_runs"];
      for (const { canonical, all } of groups.values()) {
        const variants = all.filter((p) => p !== canonical);
        if (variants.length === 0) continue;
        log.info("merging project variants", { canonical, variants });
        for (const v of variants) {
          for (const t of tables) {
            // memories has UNIQUE(project,key) — move only rows that won't collide,
            // then delete leftovers (older duplicate keys lose to canonical).
            if (t === "memories") {
              db.prepare(
                `UPDATE OR IGNORE memories SET project = ? WHERE project = ?`
              ).run(canonical, v);
              db.prepare(`DELETE FROM memories WHERE project = ?`).run(v);
            } else {
              const has = (db.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
              ).get(t)) as { name: string } | undefined;
              if (has) db.prepare(`UPDATE ${t} SET project = ? WHERE project = ?`).run(canonical, v);
            }
          }
        }
      }
    },
  },
];

export function runMigrations(db: DatabaseType): void {
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? parseInt(row.value, 10) : 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  const tx = db.transaction(() => {
    for (const m of pending) {
      log.info("running migration", { version: m.version, name: m.name });
      m.up(db);
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(
        String(m.version)
      );
    }
  });
  tx();
  log.info("migrations complete", { from: current, to: pending[pending.length - 1].version });
}
