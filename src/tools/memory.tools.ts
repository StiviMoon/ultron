// ── ULTRON v8 — memory tools (recall, remember, note, forget, search) ─────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uuid } from "../db/connection.js";
import { ok, err, errOf, truncate } from "../lib/result.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import { embedMemory, deleteVector } from "../repositories/vector.repo.js";
import { fetchProjectContext, searchMemories } from "../services/recall.service.js";
import * as decisionRepo from "../repositories/decision.repo.js";
import { db } from "../db/connection.js";

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    "recall",
    `Load full project context: last session, memories, pending tasks, technical decisions.
Optional: slim (keys only, ~80% fewer tokens), maxValueLength, fields.`,
    {
      project: z.string().describe("Project name"),
      slim: z.boolean().optional(),
      maxValueLength: z.number().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
    },
    ({ project, slim, maxValueLength, fields }) => {
      try { return ok(fetchProjectContext(project, { slim, maxValueLength, fields })); }
      catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "remember",
    `Save/update persistent knowledge. Categories: rule (always injected first), fact, pattern, preference, warning, note.
importance 1-10 controls ranking. Embeds for semantic search automatically.`,
    {
      project: z.string(),
      key: z.string(),
      value: z.string(),
      category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).default("fact"),
      importance: z.number().min(1).max(10).optional(),
      expires_at: z.string().optional(),
      related: z.array(z.string()).optional(),
      agent: z.string().optional().describe("Agent saving this (null = human/global)"),
      tool: z.string().optional(),
    },
    async ({ project, key, value, category, importance, expires_at, related, agent, tool }) => {
      try {
        if (value.length > 10000) return err("Value exceeds 10,000 character limit.");
        const prefix = key.split("-")[0];
        const similar = memoryRepo.findSimilarKeys(project, key, prefix);
        const warnings: string[] = [];
        if (similar.length > 0) warnings.push(`Similar keys exist: ${similar.map((m) => `'${m.key}'`).join(", ")}. Consider updating one.`);
        if (value.length > 600) warnings.push(`Long value (${value.length} chars). If a full plan/spec, save as .md and reference the path.`);

        const autoImportance = importance ?? ({ rule: 9, warning: 8, pattern: 7, preference: 6, fact: 5, note: 5 } as const)[category];
        const id = uuid();
        memoryRepo.upsertMemory({ id, project, key, value, category, importance: autoImportance, tool: tool ?? "claude-code", agent: agent ?? null, expires_at: expires_at ?? null, related: related ?? [] });

        // Re-fetch id (upsert may have hit existing row with a different id)
        const saved = memoryRepo.getByKey(project, key);
        if (saved) await embedMemory(saved.id);

        return ok({ saved: true, project, key, category, importance: autoImportance, value, ...(expires_at && { expires_at }), ...(related?.length && { related }), ...(warnings.length > 0 && { warnings }) });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "note",
    `Quick thought with auto-generated key. Shortcut for remember with category=note.`,
    { project: z.string(), text: z.string(), tool: z.string().optional() },
    async ({ project, text: noteText, tool }) => {
      try {
        const slug = noteText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
        const key = `note-${slug || Date.now()}`;
        const id = uuid();
        memoryRepo.upsertMemory({ id, project, key, value: noteText, category: "note", importance: 5, tool: tool ?? "claude-code", agent: null, expires_at: null, related: [] });
        const saved = memoryRepo.getByKey(project, key);
        if (saved) await embedMemory(saved.id);
        return ok({ saved: true, project, key });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "forget",
    `Delete a memory by key.`,
    { project: z.string(), key: z.string() },
    ({ project, key }) => {
      try {
        const rowid = (() => { const m = memoryRepo.getByKey(project, key); return m ? memoryRepo.getRowid(m.id) : undefined; })();
        const deleted = memoryRepo.deleteByKey(project, key);
        if (!deleted) return err(`No memory found with key '${key}' in '${project}'`);
        if (rowid !== undefined) deleteVector(rowid);
        return ok({ deleted: true, project, key });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "search",
    `Search across memories (hybrid keyword+semantic), decisions, and/or tasks.
mode: "keyword" | "semantic" | "hybrid" (default hybrid). scope selects tables. projects:['all'] for cross-project.`,
    {
      project: z.string(),
      query: z.string(),
      scope: z.array(z.enum(["memories", "decisions", "tasks"])).optional(),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
      projects: z.array(z.string()).optional(),
    },
    async ({ project, query, scope, mode, projects }) => {
      try {
        const searchIn = scope && scope.length > 0 ? scope : ["memories"];
        let targets: string[];
        if (projects?.includes("all")) targets = Array.from(new Set([project, ...memoryRepo.allProjects()]));
        else if (projects?.length) targets = Array.from(new Set([project, ...projects]));
        else targets = [project];
        const multi = targets.length > 1;
        const results: Record<string, unknown[]> = {};

        if (searchIn.includes("memories")) {
          const rows = await searchMemories(query, targets, mode ?? "hybrid", 20);
          results.memories = rows.map((m) => ({ ...(multi && { project: m.project }), key: m.key, value: truncate(m.value, 600), category: m.category }));
        }
        if (searchIn.includes("decisions")) {
          results.decisions = decisionRepo.search(query, targets, 10).map((d) => ({ ...(multi && { project: d.project }), topic: d.topic, choice: d.choice, reason: d.reason }));
        }
        if (searchIn.includes("tasks")) {
          const ph = targets.map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT project, id, text, status, priority FROM tasks WHERE project IN (${ph}) AND text LIKE ? ORDER BY created_at DESC LIMIT 10`
          ).all(...targets, `%${query}%`) as Array<{ project: string; id: string; text: string; status: string; priority: string }>;
          results.tasks = rows.map((t) => ({ ...(multi && { project: t.project }), id: t.id, text: t.text, status: t.status, priority: t.priority }));
        }

        const total = Object.values(results).reduce((s, a) => s + a.length, 0);
        return ok({ project, searched_projects: targets, query, scope: searchIn, mode: mode ?? "hybrid", total_found: total, results });
      } catch (e) { return err(errOf(e)); }
    }
  );
}
