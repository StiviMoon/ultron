// ── ULTRON v8 — memory repository ─────────────────────────────────────────────
// Pure data access for the memories table. No business logic, no token shaping.

import { db } from "../db/connection.js";
import type { Category, MemoryRow, ScoredMemoryRow } from "../db/types.js";
import { now } from "../lib/result.js";

export interface UpsertMemoryInput {
  id: string;
  project: string;
  key: string;
  value: string;
  category: Category;
  importance: number;
  tool: string | null;
  agent: string | null;
  expires_at: string | null;
  related: string[];
}

export function upsertMemory(input: UpsertMemoryInput): void {
  db.prepare(
    `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, updated_at, expires_at, related, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (project, key) DO UPDATE SET
       value = excluded.value, category = excluded.category, importance = excluded.importance,
       tool = excluded.tool, agent = excluded.agent, updated_at = excluded.updated_at,
       expires_at = excluded.expires_at, related = excluded.related,
       embedded_at = NULL`  // value changed → embedding stale → force re-embed
  ).run(
    input.id, input.project, input.key, input.value, input.category, input.importance,
    input.tool, input.agent, now(), input.expires_at, JSON.stringify(input.related)
  );
}

export function getByKey(project: string, key: string): MemoryRow | undefined {
  return db.prepare("SELECT * FROM memories WHERE project = ? AND key = ?").get(project, key) as
    | MemoryRow
    | undefined;
}

export function getRowid(id: string): number | undefined {
  const r = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(id) as
    | { rowid: number }
    | undefined;
  return r?.rowid;
}

export function deleteByKey(project: string, key: string): MemoryRow | undefined {
  const row = getByKey(project, key);
  if (!row) return undefined;
  db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
  return row;
}

export function findSimilarKeys(project: string, key: string, prefix: string): Array<{ key: string; category: string }> {
  return db
    .prepare("SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?")
    .all(project, key, `${prefix}-%`) as Array<{ key: string; category: string }>;
}

export function purgeExpired(project: string): number {
  return db
    .prepare(
      `DELETE FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    )
    .run(project).changes;
}

/** Rules: always loaded first, full values. */
export function getRules(project: string): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE project = ? AND category = 'rule'
       ORDER BY importance DESC, updated_at DESC`
    )
    .all(project) as MemoryRow[];
}

/** Relevance-scored non-rule memories (the v7 formula, preserved). */
export function getScoredMemories(project: string, limit = 20): ScoredMemoryRow[] {
  return db
    .prepare(
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
    )
    .all(project, limit) as ScoredMemoryRow[];
}

export function bumpAccess(ids: string[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1
     WHERE id IN (${ph})`
  ).run(...ids);
}

export function ftsSearch(query: string, projects: string[], limit = 20): MemoryRow[] {
  const ph = projects.map(() => "?").join(",");
  try {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE fts.memories_fts MATCH ? AND m.project IN (${ph})
         ORDER BY fts.rank LIMIT ?`
      )
      .all(query, ...projects, limit) as MemoryRow[];
  } catch {
    // FTS parse error → LIKE fallback
    return db
      .prepare(
        `SELECT * FROM memories WHERE project IN (${ph}) AND (key LIKE ? OR value LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...projects, `%${query}%`, `%${query}%`, limit) as MemoryRow[];
  }
}

export function getByIds(ids: string[]): MemoryRow[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...ids) as MemoryRow[];
}

export function allProjects(): string[] {
  return (
    db.prepare("SELECT DISTINCT project FROM memories").all() as Array<{ project: string }>
  ).map((r) => r.project);
}
