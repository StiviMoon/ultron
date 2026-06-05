// ── ULTRON v8 — recall + hybrid search service ────────────────────────────────
// Owns context shaping (preserves v7 slim/fields/diff behavior) and hybrid
// keyword+semantic search via Reciprocal Rank Fusion.

import * as memoryRepo from "../repositories/memory.repo.js";
import * as sessionRepo from "../repositories/session.repo.js";
import * as taskRepo from "../repositories/task.repo.js";
import * as decisionRepo from "../repositories/decision.repo.js";
import { searchVector } from "../repositories/vector.repo.js";
import { isVecEnabled } from "../db/connection.js";
import type { MemoryRow } from "../db/types.js";
import { now, truncate } from "../lib/result.js";
import { rrf } from "../lib/rrf.js";

export type ContextField = "sessions" | "memories" | "tasks" | "decisions";
export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface FetchContextOptions {
  slim?: boolean;
  maxValueLength?: number;
  fields?: ContextField[];
  since?: string;
}

function parseJsonArray(s: string | null): string[] {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

export function fetchProjectContext(project: string, options: FetchContextOptions = {}) {
  const { slim = false, maxValueLength = 1500, fields, since } = options;
  const loadAll = !fields || fields.length === 0;
  const load = (f: ContextField) => loadAll || (fields?.includes(f) ?? false);

  const sessions = load("sessions") ? sessionRepo.recentClosed(project, 5) : null;
  const rules = memoryRepo.getRules(project);
  const memories = load("memories") ? memoryRepo.getScoredMemories(project, 20) : null;
  const tasks = load("tasks") ? taskRepo.pending(project) : null;
  const decisions = load("decisions") ? decisionRepo.recent(project, 10) : null;

  // Track access for surfaced memories
  memoryRepo.bumpAccess([...(memories ?? []), ...rules].map((m) => m.id));

  const lastSession = sessions?.[0] ?? null;
  const isDiff = !!since;
  const filterSince = <T extends { updated_at?: string; created_at?: string }>(rows: T[] | null, field: "updated_at" | "created_at") =>
    isDiff && rows ? rows.filter((r) => (r[field] ?? "") > since!) : rows;

  const fMemories = filterSince(memories, "updated_at");
  const fTasks = filterSince(tasks, "created_at");
  const fDecisions = filterSince(decisions, "created_at");

  const processMemory = (m: MemoryRow) => {
    if (slim) return { key: m.key, category: m.category, importance: m.importance };
    const related = parseJsonArray(m.related);
    return {
      key: m.key,
      value: truncate(m.value, maxValueLength),
      category: m.category,
      importance: m.importance,
      ...(m.expires_at && { expires_at: m.expires_at }),
      ...(m.value.length > maxValueLength && { truncated: true }),
      ...(related.length > 0 && { related }),
    };
  };

  return {
    project,
    retrieved_at: now(),
    ...(isDiff && { diff_mode: true, since }),
    ...(slim && { note: "slim mode — memories without values. Use full recall if you need values." }),
    ...(rules.length > 0 && { rules: rules.map((m) => ({ key: m.key, value: m.value, importance: m.importance })) }),
    last_session: lastSession
      ? { tool: lastSession.tool, summary: truncate(lastSession.summary ?? "", 400), files: parseJsonArray(lastSession.files), ended_at: lastSession.ended_at }
      : null,
    recent_sessions: sessions
      ? sessions.slice(1, 5).map((s) => ({ tool: s.tool, summary: truncate(s.summary ?? "", 200), ended_at: s.ended_at }))
      : undefined,
    memories: fMemories ? fMemories.map(processMemory) : undefined,
    pending_tasks: fTasks
      ? fTasks.map((t, i) => {
          const tags = parseJsonArray(t.tags);
          return { position: i + 1, id: t.id, text: t.text, priority: t.priority, ...(tags.length > 0 && { tags }) };
        })
      : undefined,
    recent_decisions: fDecisions
      ? fDecisions.map((d) => ({ topic: d.topic, choice: d.choice, reason: truncate(d.reason, 300) }))
      : undefined,
  };
}

/** Hybrid memory search: FTS5 + vector KNN fused with RRF. */
export async function searchMemories(
  query: string, projects: string[], mode: SearchMode = "hybrid", limit = 20
): Promise<MemoryRow[]> {
  const useKeyword = mode === "keyword" || mode === "hybrid";
  const useSemantic = (mode === "semantic" || mode === "hybrid") && isVecEnabled();

  const keywordRows = useKeyword ? memoryRepo.ftsSearch(query, projects, limit * 2) : [];
  const semanticHits = useSemantic ? await searchVector(query, projects, limit * 2) : [];

  if (!useSemantic) {
    if (keywordRows.length > 0) memoryRepo.bumpAccess(keywordRows.slice(0, limit).map((r) => r.id));
    return keywordRows.slice(0, limit);
  }

  // Fuse rankings
  const keywordIds = keywordRows.map((r) => r.id);
  const semanticIds = semanticHits.map((h) => h.id);
  const fused = rrf([keywordIds, semanticIds]);

  const byId = new Map<string, MemoryRow>();
  for (const r of keywordRows) byId.set(r.id, r);
  const missing = semanticIds.filter((id) => !byId.has(id));
  for (const r of memoryRepo.getByIds(missing)) byId.set(r.id, r);

  const ranked = Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((r): r is MemoryRow => !!r)
    .slice(0, limit);

  memoryRepo.bumpAccess(ranked.map((r) => r.id));
  return ranked;
}
