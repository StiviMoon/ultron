// ── ULTRON v9 — export/import repository ──────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { Category } from "../db/types.js";
import { now } from "../lib/result.js";
import * as memoryRepo from "./memory.repo.js";

export const ULTRON_EXPORT_VERSION = "9.0.0";

export interface ExportPayload {
  ultron_version: string;
  exported_at: string;
  project: string;
  counts: Record<string, number>;
  data: {
    memories: unknown[];
    sessions: unknown[];
    decisions: unknown[];
    tasks: unknown[];
    memory_links: unknown[];
    agents: unknown[];
    agent_runs: unknown[];
  };
}

export function exportProject(project: string): ExportPayload {
  const t = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE project = ?`).all(project);
  const memories = t("memories");
  const memoryIds = (memories as Array<{ id: string }>).map((m) => m.id);
  let memory_links: unknown[] = [];
  if (memoryIds.length > 0) {
    const ph = memoryIds.map(() => "?").join(",");
    memory_links = db
      .prepare(`SELECT * FROM memory_links WHERE from_id IN (${ph}) OR to_id IN (${ph})`)
      .all(...memoryIds, ...memoryIds);
  }
  const agents = db.prepare("SELECT * FROM agents").all();
  const agent_runs = t("agent_runs");
  const sessions = t("sessions");
  const decisions = t("decisions");
  const tasks = t("tasks");

  return {
    ultron_version: ULTRON_EXPORT_VERSION,
    exported_at: now(),
    project,
    counts: {
      memories: memories.length,
      sessions: sessions.length,
      decisions: decisions.length,
      tasks: tasks.length,
      memory_links: memory_links.length,
      agents: agents.length,
      agent_runs: agent_runs.length,
    },
    data: { memories, sessions, decisions, tasks, memory_links, agents, agent_runs },
  };
}

export function importProject(
  payload: ExportPayload,
  strategy: "merge" | "replace"
): Record<string, number> {
  const { project, data } = payload;
  const counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0, memory_links: 0, agents: 0, agent_runs: 0 };

  const tx = db.transaction(() => {
    if (strategy === "replace") {
      const memoryIds = (db.prepare("SELECT id FROM memories WHERE project = ?").all(project) as Array<{ id: string }>).map((m) => m.id);
      if (memoryIds.length > 0) {
        const ph = memoryIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM memory_links WHERE from_id IN (${ph}) OR to_id IN (${ph})`).run(...memoryIds, ...memoryIds);
      }
      for (const t of ["memories", "sessions", "decisions", "tasks", "agent_runs"]) {
        db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
      }
    }

    const memStmt = db.prepare(
      `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, expires_at, last_accessed_at, access_count, related, created_at, updated_at, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project, key) DO UPDATE SET
         value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
         category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
         importance = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.importance ELSE memories.importance END,
         updated_at = MAX(excluded.updated_at, memories.updated_at),
         access_count = MAX(excluded.access_count, memories.access_count),
         embedded_at = NULL`
    );
    for (const m of data.memories ?? []) {
      const row = m as Record<string, unknown>;
      memStmt.run(
        row.id, row.project, row.key, row.value, row.category,
        row.importance ?? 5, row.tool, row.agent ?? null, row.expires_at,
        row.last_accessed_at, row.access_count ?? 0,
        typeof row.related === "string" ? row.related : JSON.stringify(row.related ?? []),
        row.created_at, row.updated_at
      );
      counts.memories++;
    }

    const sesStmt = db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of data.sessions ?? []) {
      const row = s as Record<string, unknown>;
      sesStmt.run(
        row.id, row.project, row.tool, row.summary,
        typeof row.files === "string" ? row.files : JSON.stringify(row.files ?? []),
        row.started_at, row.ended_at, row.created_at
      );
      counts.sessions++;
    }

    const decStmt = db.prepare(
      `INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, supersedes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of data.decisions ?? []) {
      const row = d as Record<string, unknown>;
      decStmt.run(row.id, row.project, row.topic, row.choice, row.reason, row.tool, row.supersedes ?? null, row.created_at);
      counts.decisions++;
    }

    const taskStmt = db.prepare(
      `INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tags, tool, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of data.tasks ?? []) {
      const row = t as Record<string, unknown>;
      taskStmt.run(
        row.id, row.project, row.text, row.status, row.priority,
        typeof row.tags === "string" ? row.tags : JSON.stringify(row.tags ?? []),
        row.tool, row.created_at, row.done_at
      );
      counts.tasks++;
    }

    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const l of data.memory_links ?? []) {
      const row = l as Record<string, unknown>;
      linkStmt.run(row.from_id, row.to_id, row.relation, row.weight ?? 1.0, row.created_at);
      counts.memory_links++;
    }

    const agentStmt = db.prepare(
      `INSERT INTO agents (id, name, type, capabilities, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
    );
    for (const a of data.agents ?? []) {
      const row = a as Record<string, unknown>;
      agentStmt.run(
        row.id, row.name, row.type,
        typeof row.capabilities === "string" ? row.capabilities : JSON.stringify(row.capabilities ?? []),
        row.registered_at
      );
      counts.agents++;
    }

    const runStmt = db.prepare(
      `INSERT OR IGNORE INTO agent_runs (id, agent, project, action, detail, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.agent_runs ?? []) {
      const row = r as Record<string, unknown>;
      runStmt.run(row.id, row.agent, row.project, row.action, row.detail, row.started_at, row.ended_at);
      counts.agent_runs++;
    }

    return counts;
  });
  return tx();
}

export async function compressMemories(
  project: string,
  keys: string[],
  newKey: string,
  newValue: string,
  newCategory: Category
): Promise<{ deletedKeys: string[]; newId: string; maxImportance: number }> {
  const sources = db
    .prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${keys.map(() => "?").join(",")})`)
    .all(project, ...keys) as Array<{ key: string; value: string; category: string; importance: number; related: string }>;

  if (sources.length === 0) throw new Error(`No memories found for keys: ${keys.join(", ")}`);

  const maxImp = Math.max(...sources.map((m) => m.importance ?? 5));
  const allRelated = Array.from(
    new Set(
      sources.flatMap((m) => {
        try { return JSON.parse(m.related || "[]") as string[]; } catch { return []; }
      }).filter((k) => !keys.includes(k))
    )
  );

  memoryRepo.deleteMemories(project, keys);
  const id = uuid();
  memoryRepo.upsertMemory({
    id, project, key: newKey, value: newValue, category: newCategory,
    importance: maxImp, tool: "claude-code", agent: null, expires_at: null, related: allRelated,
  });
  const saved = memoryRepo.getByKey(project, newKey);
  return { deletedKeys: sources.map((m) => m.key), newId: saved?.id ?? id, maxImportance: maxImp };
}
