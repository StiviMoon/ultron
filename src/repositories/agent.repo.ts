// ── ULTRON v9 — agent repository ──────────────────────────────────────────────

import { db, uuid } from "../db/connection.js";
import type { AgentRow, AgentRunRow } from "../db/types.js";
import { now } from "../lib/result.js";
import * as memoryRepo from "./memory.repo.js";
import { embedMemory } from "./vector.repo.js";

export function registerAgent(name: string, type: string, capabilities: string[]): void {
  db.prepare(
    `INSERT INTO agents (id, name, type, capabilities) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
  ).run(uuid(), name, type, JSON.stringify(capabilities));
}

export function logRun(
  agent: string, action: string, project: string | null, detail: string | null
): string {
  const id = uuid();
  db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail) VALUES (?, ?, ?, ?, ?)").run(
    id, agent, project, action, detail
  );
  return id;
}

export function endRun(runId: string, detail: string | null): void {
  db.prepare("UPDATE agent_runs SET ended_at = ?, detail = COALESCE(?, detail) WHERE id = ?").run(
    now(), detail, runId
  );
}

export async function handoff(
  project: string, fromAgent: string, toAgent: string, context: string
): Promise<{ key: string; id: string }> {
  const key = `handoff-${toAgent}`;
  const id = uuid();
  memoryRepo.upsertMemory({
    id, project, key,
    value: `[from ${fromAgent} → ${toAgent}] ${context}`,
    category: "note", importance: 8, tool: "agent", agent: fromAgent,
    expires_at: null, related: [],
  });
  const saved = memoryRepo.getByKey(project, key);
  if (saved) await embedMemory(saved.id);
  return { key, id: saved?.id ?? id };
}

export function listAgents(): AgentRow[] {
  return db.prepare("SELECT * FROM agents ORDER BY registered_at DESC").all() as AgentRow[];
}

export function listRuns(limit = 50): AgentRunRow[] {
  return db
    .prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as AgentRunRow[];
}
