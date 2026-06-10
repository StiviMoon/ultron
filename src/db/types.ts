// ── ULTRON v8 — row types (kills `as any`) ────────────────────────────────────

export type Category = "fact" | "pattern" | "preference" | "warning" | "note" | "rule";
export type TaskStatus = "pending" | "done";
export type Priority = "high" | "medium" | "low";

export interface MemoryRow {
  id: string;
  project: string;
  key: string;
  value: string;
  category: Category;
  tool: string | null;
  agent: string | null;
  expires_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  importance: number;
  related: string;        // JSON array of keys
  embedded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  project: string;
  tool: string;
  summary: string | null;
  files: string;          // JSON array
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  project: string;
  topic: string;
  choice: string;
  reason: string;
  tool: string | null;
  supersedes: string | null;
  created_at: string;
}

export interface TaskRow {
  id: string;
  project: string;
  text: string;
  status: TaskStatus;
  priority: Priority;
  tags: string;           // JSON array
  tool: string | null;
  created_at: string;
  done_at: string | null;
}

export interface MemoryLinkRow {
  from_id: string;
  to_id: string;
  relation: string;       // 'manual' | 'semantic'
  weight: number;
  created_at: string;
}

export interface AgentRow {
  id: string;
  name: string;
  type: string;           // 'subagent' | 'daemon'
  capabilities: string;   // JSON array
  registered_at: string;
}

export interface AgentRunRow {
  id: string;
  agent: string;
  project: string | null;
  action: string;
  detail: string | null;
  started_at: string;
  ended_at: string | null;
}

/** Memory row enriched with computed relevance score from ranking queries */
export interface ScoredMemoryRow extends MemoryRow {
  relevance_score: number;
}
