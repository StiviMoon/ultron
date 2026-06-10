// ── ULTRON v8 — decision repository ───────────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { DecisionRow } from "../db/types.js";

export function add(
  project: string, topic: string, choice: string, reason: string,
  tool: string | null, supersedes?: string | null
): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO decisions (id, project, topic, choice, reason, tool, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, project, topic, choice, reason, tool, supersedes ?? null);
  return id;
}

export function recent(project: string, limit = 10): DecisionRow[] {
  return db
    .prepare("SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?")
    .all(project, limit) as DecisionRow[];
}

export function paginate(project: string, limit: number, offset: number): { total: number; rows: DecisionRow[] } {
  const total = (db.prepare("SELECT COUNT(*) c FROM decisions WHERE project = ?").get(project) as { c: number }).c;
  const rows = db
    .prepare("SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(project, limit, offset) as DecisionRow[];
  return { total, rows };
}

export function search(query: string, projects: string[], limit = 10): DecisionRow[] {
  const ph = projects.map(() => "?").join(",");
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const clauses = terms.map(() => "(topic LIKE ? OR choice LIKE ? OR reason LIKE ?)").join(" AND ");
  const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return db
    .prepare(
      `SELECT * FROM decisions WHERE project IN (${ph}) AND ${clauses}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...projects, ...args, limit) as DecisionRow[];
}

export function getChain(project: string, decisionId: string): DecisionRow[] {
  const chain: DecisionRow[] = [];
  let current = db.prepare("SELECT * FROM decisions WHERE id = ? AND project = ?").get(decisionId, project) as DecisionRow | undefined;
  while (current) {
    chain.unshift(current);
    if (!current.supersedes) break;
    current = db.prepare("SELECT * FROM decisions WHERE id = ? AND project = ?").get(current.supersedes, project) as DecisionRow | undefined;
  }
  const newer = db.prepare("SELECT * FROM decisions WHERE project = ? AND supersedes = ?").all(project, decisionId) as DecisionRow[];
  return [...chain, ...newer];
}
