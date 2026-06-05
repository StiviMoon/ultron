// ── ULTRON v8 — decision repository ───────────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { DecisionRow } from "../db/types.js";

export function add(project: string, topic: string, choice: string, reason: string, tool: string | null): string {
  const id = uuid();
  db.prepare("INSERT INTO decisions (id, project, topic, choice, reason, tool) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, project, topic, choice, reason, tool
  );
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
  return db
    .prepare(
      `SELECT * FROM decisions WHERE project IN (${ph})
       AND (topic LIKE ? OR choice LIKE ? OR reason LIKE ?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...projects, `%${query}%`, `%${query}%`, `%${query}%`, limit) as DecisionRow[];
}
