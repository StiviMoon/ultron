// ── ULTRON v9 — project repository ────────────────────────────────────────────

import { db } from "../db/connection.js";
import { truncate } from "../lib/result.js";
import * as sessionRepo from "./session.repo.js";

export interface ProjectStats {
  project: string;
  last_session: { tool: string; summary: string; ended_at: string } | null;
  pending_tasks: number;
  memories_count: number;
  decisions_count: number;
}

export function allProjectNames(): string[] {
  return (
    db.prepare(
      `SELECT DISTINCT project FROM (
         SELECT project FROM memories UNION SELECT project FROM sessions
         UNION SELECT project FROM tasks UNION SELECT project FROM decisions
       )`
    ).all() as Array<{ project: string }>
  ).map((r) => r.project);
}

export function getStats(project: string): ProjectStats {
  const last = sessionRepo.lastClosed(project);
  const c = (sql: string) => (db.prepare(sql).get(project) as { c: number } | undefined)?.c ?? 0;
  return {
    project,
    last_session: last
      ? { tool: last.tool, summary: truncate(last.summary ?? "", 150), ended_at: last.ended_at! }
      : null,
    pending_tasks: c("SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'"),
    memories_count: c("SELECT COUNT(*) c FROM memories WHERE project = ?"),
    decisions_count: c("SELECT COUNT(*) c FROM decisions WHERE project = ?"),
  };
}

export function listWithStats(): ProjectStats[] {
  const list = allProjectNames().map(getStats);
  list.sort((a, b) => {
    if (!a.last_session) return 1;
    if (!b.last_session) return -1;
    return new Date(b.last_session.ended_at).getTime() - new Date(a.last_session.ended_at).getTime();
  });
  return list;
}
