// ── ULTRON v8 — task repository ───────────────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { TaskRow, Priority } from "../db/types.js";
import { now } from "../lib/result.js";

const PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END";

export function pending(project: string): TaskRow[] {
  return db
    .prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'pending' ORDER BY ${PRIORITY_ORDER}, created_at ASC`)
    .all(project) as TaskRow[];
}

export function all(project: string): TaskRow[] {
  return db
    .prepare(`SELECT * FROM tasks WHERE project = ? ORDER BY ${PRIORITY_ORDER}, created_at ASC`)
    .all(project) as TaskRow[];
}

export function add(project: string, text: string, priority: Priority, tags: string[], tool: string | null): string {
  const id = uuid();
  db.prepare("INSERT INTO tasks (id, project, text, priority, tags, tool) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, project, text, priority, JSON.stringify(tags), tool
  );
  return id;
}

/** Resolve a numeric position (1-based, among pending) or pass through a UUID. */
export function resolveId(project: string, rawId: string): string | null {
  const pos = parseInt(rawId, 10);
  if (!isNaN(pos) && String(pos) === rawId) {
    const list = db
      .prepare("SELECT id FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(project) as Array<{ id: string }>;
    return list[pos - 1]?.id ?? null;
  }
  return rawId;
}

export function update(
  project: string, id: string,
  fields: { text?: string; priority?: Priority; tags?: string[] }
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.text !== undefined) { sets.push("text = ?"); vals.push(fields.text); }
  if (fields.priority !== undefined) { sets.push("priority = ?"); vals.push(fields.priority); }
  if (fields.tags !== undefined) { sets.push("tags = ?"); vals.push(JSON.stringify(fields.tags)); }
  if (sets.length === 0) return;
  vals.push(id, project);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project = ?`).run(...vals);
}

export function markDone(project: string, id: string): void {
  db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND project = ?").run(now(), id, project);
}

export function remove(project: string, id: string): void {
  db.prepare("DELETE FROM tasks WHERE id = ? AND project = ?").run(id, project);
}

export function topPending(project: string, limit = 5): Array<{ text: string; priority: string }> {
  return db
    .prepare(`SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending' ORDER BY ${PRIORITY_ORDER} LIMIT ?`)
    .all(project, limit) as Array<{ text: string; priority: string }>;
}
