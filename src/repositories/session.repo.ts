// ── ULTRON v8 — session repository ────────────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { SessionRow } from "../db/types.js";
import { now } from "../lib/result.js";

export function recentClosed(project: string, limit = 5): SessionRow[] {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?"
    )
    .all(project, limit) as SessionRow[];
}

export function lastClosed(project: string): SessionRow | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
    )
    .get(project) as SessionRow | undefined;
}

export function open(project: string, tool: string): string {
  const id = uuid();
  db.prepare("INSERT INTO sessions (id, project, tool) VALUES (?, ?, ?)").run(id, project, tool);
  return id;
}

export function findOpen(project: string, tool: string): { id: string } | undefined {
  return db
    .prepare(
      "SELECT id FROM sessions WHERE project = ? AND tool = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get(project, tool) as { id: string } | undefined;
}

export function close(id: string, summary: string, files: string[]): void {
  db.prepare("UPDATE sessions SET summary = ?, files = ?, ended_at = ? WHERE id = ?").run(
    summary, JSON.stringify(files), now(), id
  );
}

/** Auto-close sessions left open longer than the cutoff (ISO). Returns count. */
export function closeStale(project: string, cutoffIso: string): number {
  return db
    .prepare(
      `UPDATE sessions SET ended_at = ?, summary = 'Auto-closed — stale session (>2h without session_end)'
       WHERE project = ? AND ended_at IS NULL AND started_at < ?`
    )
    .run(now(), project, cutoffIso).changes;
}
