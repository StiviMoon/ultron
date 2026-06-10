// ── ULTRON v8 — health + metrics service ──────────────────────────────────────

import { db, isVecEnabled } from "../db/connection.js";
import { estimateTokens } from "../lib/tokens.js";

export interface HealthIssue {
  severity: "error" | "warning" | "info";
  message: string;
  action?: string;
}

export function projectHealth(project: string) {
  const issues: HealthIssue[] = [];
  const count = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(project, ...args) as { c: number } | undefined)?.c ?? 0;

  const expired = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`);
  if (expired > 0) issues.push({ severity: "error", message: `${expired} expired memories still in DB`, action: "session_start() auto-purges them" });

  const neverAccessed = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND access_count = 0 AND created_at < datetime('now','-30 days') AND category != 'rule'`);
  if (neverAccessed > 3) issues.push({ severity: "warning", message: `${neverAccessed} memories never accessed in 30+ days`, action: "clean(project,'list') then forget()" });

  const snapshot = db.prepare(`SELECT updated_at FROM memories WHERE project = ? AND key = '_snapshot'`).get(project) as { updated_at: string } | undefined;
  const lastSession = db.prepare(`SELECT ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`).get(project) as { ended_at: string } | undefined;
  if (lastSession && !snapshot) issues.push({ severity: "warning", message: "No snapshot — session_end() never called", action: "Call session_end() when finishing" });
  else if (snapshot && lastSession) {
    const ageDays = (Date.now() - new Date(snapshot.updated_at).getTime()) / 86400000;
    if (ageDays > 7) issues.push({ severity: "info", message: `Snapshot is ${Math.round(ageDays)}d old`, action: "Call session_end() to refresh" });
  }

  const totalMemories = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`);
  const values = db.prepare(`SELECT value FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`).all(project) as Array<{ value: string }>;
  const estTokens = estimateTokens(values.map((v) => v.value).join(""));
  if (estTokens > 8000) issues.push({ severity: "warning", message: `High token footprint: ~${estTokens} tokens across ${totalMemories} memories`, action: "Use slim:true or clean stale" });

  const prefixes = db.prepare(
    `SELECT SUBSTR(key,1,INSTR(key||'-','-')-1) prefix, COUNT(*) c FROM memories WHERE project = ? AND key != '_snapshot' GROUP BY prefix HAVING c >= 4`
  ).all(project) as Array<{ prefix: string; c: number }>;
  for (const p of prefixes) {
    const keys = db.prepare(
      `SELECT key FROM memories WHERE project = ? AND key LIKE ? AND key != '_snapshot' LIMIT 5`
    ).all(project, `${p.prefix}-%`) as Array<{ key: string }>;
    issues.push({
      severity: "info",
      message: `Prefix '${p.prefix}-' has ${p.c} memories — possible overlap`,
      action: `compress(project, keys=[${keys.map((k) => `'${k.key}'`).join(", ")}], new_key='${p.prefix}-summary', new_value='...')`,
    });
  }

  // v8: embeddings missing
  if (isVecEnabled()) {
    const missingEmb = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND embedded_at IS NULL`);
    if (missingEmb > 0) issues.push({ severity: "info", message: `${missingEmb} memories without semantic embedding`, action: "runs automatically on save; backfill via daemon" });
  }

  const rules = count(`SELECT COUNT(*) c FROM memories WHERE project = ? AND category = 'rule'`);
  const pendingTasks = count(`SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'`);

  const score = Math.max(0, 100
    - issues.filter((i) => i.severity === "error").length * 20
    - issues.filter((i) => i.severity === "warning").length * 10
    - issues.filter((i) => i.severity === "info").length * 5);

  return {
    project,
    health_score: score,
    status: score >= 80 ? "healthy" : score >= 50 ? "needs_attention" : "degraded",
    stats: { total_memories: totalMemories, rules, pending_tasks: pendingTasks, estimated_tokens: estTokens, expired_memories: expired },
    issues,
    ...(issues.length === 0 && { message: "Project memory is clean and optimized." }),
  };
}

export function globalMetrics(project?: string) {
  const where = project ? "WHERE project = ?" : "";
  const args = project ? [project] : [];
  const one = (sql: string) => (db.prepare(sql).get(...args) as { c: number } | undefined)?.c ?? 0;

  const memories = one(`SELECT COUNT(*) c FROM memories ${where}`);
  const sessions = one(`SELECT COUNT(*) c FROM sessions ${where}`);
  const decisions = one(`SELECT COUNT(*) c FROM decisions ${where}`);
  const tasks = one(`SELECT COUNT(*) c FROM tasks ${where}`);
  const embedded = one(`SELECT COUNT(*) c FROM memories ${where ? where + " AND" : "WHERE"} embedded_at IS NOT NULL`);

  const topAccessed = db.prepare(
    `SELECT project, key, access_count FROM memories ${where} ORDER BY access_count DESC LIMIT 10`
  ).all(...args);

  const agentRuns = (db.prepare("SELECT COUNT(*) c FROM agent_runs").get() as { c: number }).c;

  return {
    ...(project && { project }),
    counts: { memories, sessions, decisions, tasks, embedded, agent_runs: agentRuns },
    semantic_coverage: memories > 0 ? `${Math.round((embedded / memories) * 100)}%` : "0%",
    vec_enabled: isVecEnabled(),
    top_accessed_memories: topAccessed,
  };
}
