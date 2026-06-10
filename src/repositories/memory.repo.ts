// ── ULTRON v9 — memory repository ─────────────────────────────────────────────
// Pure data access for the memories table. All deletes go through deleteMemories
// so vectors and graph links are always cleaned up.

import { db } from "../db/connection.js";
import type { Category, MemoryRow, ScoredMemoryRow } from "../db/types.js";
import { now } from "../lib/result.js";
import { deleteVector } from "./vector.repo.js";

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
       embedded_at = NULL`
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

/** Centralized delete: vectors + memory_links + memories in one transaction. */
export function deleteMemories(project: string, keys: string[]): number {
  if (keys.length === 0) return 0;
  const ph = keys.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, rowid FROM memories WHERE project = ? AND key IN (${ph})`)
    .all(project, ...keys) as Array<{ id: string; rowid: number }>;
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

export function deleteByKey(project: string, key: string): boolean {
  return deleteMemories(project, [key]) > 0;
}

export function findSimilarKeys(project: string, key: string, prefix: string): Array<{ key: string; category: string }> {
  return db
    .prepare("SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?")
    .all(project, key, `${prefix}-%`) as Array<{ key: string; category: string }>;
}

export function purgeExpired(project: string): number {
  const expired = db
    .prepare(
      `SELECT key FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    )
    .all(project) as Array<{ key: string }>;
  return deleteMemories(project, expired.map((e) => e.key));
}

export function purgeExpiredAll(): number {
  const expired = db
    .prepare(
      `SELECT project, key FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
    )
    .all() as Array<{ project: string; key: string }>;
  const byProject = new Map<string, string[]>();
  for (const e of expired) {
    const list = byProject.get(e.project) ?? [];
    list.push(e.key);
    byProject.set(e.project, list);
  }
  let total = 0;
  for (const [project, keys] of byProject) total += deleteMemories(project, keys);
  return total;
}

export function getStaleMemories(
  project: string,
  thresholdDays: number
): Array<{ key: string; category: string; value: string; last_accessed_at: string | null; created_at: string }> {
  return db
    .prepare(
      `SELECT key, category, value, last_accessed_at, created_at FROM memories
       WHERE project = ? AND key != '_snapshot'
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-' || ? || ' days'))
       ORDER BY last_accessed_at ASC NULLS FIRST`
    )
    .all(project, thresholdDays) as Array<{
      key: string; category: string; value: string; last_accessed_at: string | null; created_at: string;
    }>;
}

export function getMemoriesByKeys(
  project: string,
  keys: string[]
): Array<{ key: string; value: string; category: string; importance: number; related: string }> {
  if (keys.length === 0) return [];
  const ph = keys.map(() => "?").join(",");
  return db
    .prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${ph})`)
    .all(project, ...keys) as Array<{ key: string; value: string; category: string; importance: number; related: string }>;
}

export function saveSnapshot(project: string, value: string, tool: string, id: string): string {
  upsertMemory({
    id, project, key: "_snapshot", value, category: "note",
    importance: 7, tool, agent: null, expires_at: null, related: [],
  });
  const saved = getByKey(project, "_snapshot");
  return saved?.id ?? id;
}

export function getRecentKeys(project: string, limit = 8): string[] {
  return (
    db.prepare(
      "SELECT key FROM memories WHERE project = ? AND key != '_snapshot' ORDER BY updated_at DESC LIMIT ?"
    ).all(project, limit) as Array<{ key: string }>
  ).map((m) => m.key);
}

export function getRulesMemories(
  project: string,
  categories: Category[]
): Array<{ key: string; value: string; category: string }> {
  const ph = categories.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT key, value, category FROM memories WHERE project = ? AND category IN (${ph})
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY CASE category WHEN 'rule' THEN 0 WHEN 'warning' THEN 1 WHEN 'pattern' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END,
                importance DESC, key`
    )
    .all(project, ...categories) as Array<{ key: string; value: string; category: string }>;
}

export function decayImportance(project: string, days = 60): number {
  return db
    .prepare(
      `UPDATE memories SET importance = MAX(1, importance - 1)
       WHERE project = ? AND category NOT IN ('rule', 'warning')
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-' || ? || ' days'))
         AND importance > 1`
    )
    .run(project, days).changes;
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

export function ftsSearch(
  query: string,
  projects: string[],
  limit = 20,
  opts?: { category?: Category; minImportance?: number }
): MemoryRow[] {
  const ph = projects.map(() => "?").join(",");
  const filters: string[] = [];
  const filterArgs: unknown[] = [];
  if (opts?.category) { filters.push("m.category = ?"); filterArgs.push(opts.category); }
  if (opts?.minImportance !== undefined) { filters.push("m.importance >= ?"); filterArgs.push(opts.minImportance); }
  const extra = filters.length ? ` AND ${filters.join(" AND ")}` : "";

  try {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.rowid = fts.rowid
         WHERE fts.memories_fts MATCH ? AND m.project IN (${ph})${extra}
         ORDER BY fts.rank LIMIT ?`
      )
      .all(query, ...projects, ...filterArgs, limit) as MemoryRow[];
  } catch {
    return db
      .prepare(
        `SELECT * FROM memories WHERE project IN (${ph}) AND (key LIKE ? OR value LIKE ?)${extra.replace(/m\./g, "")}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...projects, ...filterArgs, `%${query}%`, `%${query}%`, limit) as MemoryRow[];
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

export function listForHandoff(project: string, limit = 20): Array<{ key: string; value: string; category: string }> {
  return db
    .prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT ?")
    .all(project, limit) as Array<{ key: string; value: string; category: string }>;
}

export function tokenBudgetRows(project: string) {
  return {
    memories: db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30").all(project),
    sessions: db.prepare("SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5").all(project),
    tasks: db.prepare("SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'").all(project),
    decisions: db.prepare("SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10").all(project),
    staleCount: (db.prepare(
      `SELECT COUNT(*) c FROM memories WHERE project = ? AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-45 days'))`
    ).get(project) as { c: number }).c,
  };
}
