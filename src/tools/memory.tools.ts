// ── ULTRON v9 — memory tools ───────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uuid } from "../db/connection.js";
import { err } from "../lib/result.js";
import { defineTool } from "../lib/define-tool.js";
import { withActions, rememberActions } from "../lib/next-actions.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import * as taskRepo from "../repositories/task.repo.js";
import { embedMemory } from "../repositories/vector.repo.js";
import { fetchProjectContext, searchMemories } from "../services/recall.service.js";
import { enrichSearchResults } from "../services/search-enrichment.service.js";
import * as decisionRepo from "../repositories/decision.repo.js";
import { truncate } from "../lib/result.js";

export function registerMemoryTools(server: McpServer): void {
  defineTool(
    server, "recall",
    `Load project context: last session, memories, tasks, decisions.
WHEN: Need context mid-session without starting a new session.
NOT: At session start — use session_start instead (also opens session).
Example: recall("api", slim=true, fields=["tasks","decisions"])
Returns: Structured context. slim=true saves ~80% tokens (keys only).`,
    {
      project: z.string().describe("Project name"),
      slim: z.boolean().optional(),
      maxValueLength: z.number().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
    },
    ({ project, slim, maxValueLength, fields }) =>
      fetchProjectContext(project, { slim, maxValueLength, fields })
  );

  defineTool(
    server, "remember",
    `Save persistent knowledge that must survive this session.
WHEN: After discovering something non-obvious (bug cause, pattern, constraint).
NOT: For transient info (current file state, debug output).
Example: remember("api", "auth-gotcha", "JWT expires in 5m in dev", "warning")
Categories: rule > warning > pattern > preference > fact > note. Auto-embeds for search.`,
    {
      project: z.string(),
      key: z.string(),
      value: z.string(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).default("fact"),
      importance: z.number().min(1).max(10).optional(),
      expires_at: z.string().optional(),
      related: z.array(z.string()).optional(),
      agent: z.string().optional(),
      tool: z.string().optional(),
    },
    async ({ project, key, value, category, importance, expires_at, related, agent, tool }) => {
      if (value.length > 10000) return err("Value exceeds 10,000 character limit.");
      const prefix = key.split("-")[0];
      const similar = memoryRepo.findSimilarKeys(project, key, prefix);
      const warnings: string[] = [];
      if (similar.length > 0) warnings.push(`Similar keys exist: ${similar.map((m) => `'${m.key}'`).join(", ")}. Consider updating one.`);
      if (value.length > 600) warnings.push(`Long value (${value.length} chars). If a full plan/spec, save as .md and reference the path.`);

      const autoImportance = importance ?? ({ rule: 9, warning: 8, pattern: 7, preference: 6, fact: 5, note: 5 } as const)[category];
      const id = uuid();
      memoryRepo.upsertMemory({ id, project, key, value, category, importance: autoImportance, tool: tool ?? "claude-code", agent: agent ?? null, expires_at: expires_at ?? null, related: related ?? [] });
      const saved = memoryRepo.getByKey(project, key);
      if (saved) await embedMemory(saved.id);

      return withActions(
        { saved: true, project, key, category, importance: autoImportance, value, ...(expires_at && { expires_at }), ...(related?.length && { related }), ...(warnings.length > 0 && { warnings }) },
        rememberActions(warnings, similar.length)
      );
    }
  );

  defineTool(
    server, "note",
    `Quick thought with auto-generated key. Shortcut for remember(category=note).
WHEN: Fast capture without choosing a key.
Example: note("api", "Stripe test mode uses sk_test_ prefix")
Returns: Auto key like note-stripe-test-mode-uses.`,
    { project: z.string(), text: z.string(), tool: z.string().optional() },
    async ({ project, text: noteText, tool }) => {
      const slug = noteText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
      const key = `note-${slug || Date.now()}`;
      const id = uuid();
      memoryRepo.upsertMemory({ id, project, key, value: noteText, category: "note", importance: 5, tool: tool ?? "claude-code", agent: null, expires_at: null, related: [] });
      const saved = memoryRepo.getByKey(project, key);
      if (saved) await embedMemory(saved.id);
      return withActions({ saved: true, project, key }, ["Use remember() with a descriptive key for important notes"]);
    }
  );

  defineTool(
    server, "forget",
    `Delete a memory by key. Also removes vector embedding and graph links.
WHEN: Knowledge is outdated or wrong.
Example: forget("api", "old-auth-flow")
Returns: deleted:true or error if key not found.`,
    { project: z.string(), key: z.string() },
    ({ project, key }) => {
      const deleted = memoryRepo.deleteByKey(project, key);
      if (!deleted) return err(`No memory found with key '${key}' in '${project}'`);
      return withActions({ deleted: true, project, key }, ["Run search() to confirm it's gone"]);
    }
  );

  defineTool(
    server, "search",
    `Search memories (hybrid keyword+semantic), decisions, and/or tasks.
WHEN: Looking for existing knowledge before creating duplicates.
Example: search("api", "stripe webhook", mode="hybrid", scope=["memories","decisions"])
mode: keyword | semantic | hybrid (default). projects:["all"] for cross-project.`,
    {
      project: z.string(),
      query: z.string(),
      scope: z.array(z.enum(["memories", "decisions", "tasks"])).optional(),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
      projects: z.array(z.string()).optional(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional(),
      min_importance: z.number().min(1).max(10).optional(),
    },
    async ({ project, query, scope, mode, projects, category, min_importance }) => {
      const searchIn = scope && scope.length > 0 ? scope : ["memories"];
      let targets: string[];
      if (projects?.includes("all")) targets = Array.from(new Set([project, ...memoryRepo.allProjects()]));
      else if (projects?.length) targets = Array.from(new Set([project, ...projects]));
      else targets = [project];
      const multi = targets.length > 1;
      const results: Record<string, unknown[]> = {};
      const filters = { category, minImportance: min_importance };
      let enrichment: ReturnType<typeof enrichSearchResults> | undefined;

      if (searchIn.includes("memories")) {
        const rows = await searchMemories(query, targets, mode ?? "hybrid", 20, filters);
        results.memories = rows.map((m) => ({ ...(multi && { project: m.project }), key: m.key, value: truncate(m.value, 600), category: m.category }));
        if (!multi && rows.length > 0) enrichment = enrichSearchResults(project, query, rows);
        else if (!multi && rows.length === 0) enrichment = enrichSearchResults(project, query, []);
      }
      if (searchIn.includes("decisions")) {
        results.decisions = decisionRepo.search(query, targets, 10).map((d) => ({ ...(multi && { project: d.project }), topic: d.topic, choice: d.choice, reason: d.reason }));
      }
      if (searchIn.includes("tasks")) {
        results.tasks = taskRepo.search(query, targets, 10).map((t) => ({ ...(multi && { project: t.project }), id: t.id, text: t.text, status: t.status, priority: t.priority }));
      }

      const total = Object.values(results).reduce((s, a) => s + a.length, 0);
      const actions: string[] = total === 0
        ? ["No results — safe to create new knowledge with remember()"]
        : ["Review results before creating duplicates"];
      if (enrichment?.related_suggestions.length) {
        actions.push(`Related keys via graph: ${enrichment.related_suggestions.map((r) => r.key).join(", ")}`);
      }
      if (enrichment?.knowledge_gaps.length) {
        actions.push(...enrichment.knowledge_gaps);
      }
      return withActions(
        {
          project, searched_projects: targets, query, scope: searchIn, mode: mode ?? "hybrid", total_found: total, results,
          ...(enrichment?.related_suggestions.length && { related_suggestions: enrichment.related_suggestions }),
          ...(enrichment?.knowledge_gaps.length && { knowledge_gaps: enrichment.knowledge_gaps }),
        },
        actions
      );
    }
  );
}
