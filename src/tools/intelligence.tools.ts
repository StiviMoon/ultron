// ── ULTRON v9 — intelligence tools ──────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err } from "../lib/result.js";
import { defineTool, defineTextTool } from "../lib/define-tool.js";
import { withActions, healthActions } from "../lib/next-actions.js";
import { estimateTokens } from "../lib/tokens.js";
import { projectHealth, globalMetrics } from "../services/health.service.js";
import { neighborhood, rebuildManualLinks, rebuildSemanticLinks } from "../services/graph.service.js";
import { generateRules } from "../services/rules.service.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import { embedMemory } from "../repositories/vector.repo.js";
import { compressMemories } from "../repositories/sync.repo.js";

export function registerIntelligenceTools(server: McpServer): void {
  defineTool(
    server, "health",
    `Project integrity diagnostics — stale, expired, snapshot age, overlap, missing embeddings, token bloat.
WHEN: Before a big session or when recall feels slow.
Example: health("api") → health_score, issues with actionable fixes.`,
    { project: z.string() },
    ({ project }) => {
      const h = projectHealth(project);
      return withActions(h, healthActions(h.health_score, h.issues.length));
    }
  );

  defineTool(
    server, "metrics",
    `Usage + semantic-coverage metrics. Omit project for global view.
WHEN: Check embedding coverage or most-accessed memories.
Example: metrics("api") or metrics() for global.`,
    { project: z.string().optional() },
    ({ project }) => globalMetrics(project)
  );

  defineTool(
    server, "graph",
    `Knowledge graph around a memory key. BFS neighborhood up to depth hops.
WHEN: Explore related knowledge or find connections.
Example: graph("api", "auth-flow", depth=2, rebuild=true)
Edges: manual (from related) + semantic (embedding similarity).`,
    { project: z.string(), key: z.string(), depth: z.number().optional().default(1), rebuild: z.boolean().optional() },
    async ({ project, key, depth, rebuild }) => {
      if (rebuild) { rebuildManualLinks(project); await rebuildSemanticLinks(project); }
      return neighborhood(project, key, depth ?? 1);
    }
  );

  defineTool(
    server, "compress",
    `Collapse multiple related memories into one structured memory.
WHEN: health reports prefix overlap or too many similar keys.
Example: compress("api", keys=["auth-jwt","auth-refresh"], new_key="auth-summary", new_value="...")
Use preview_only:true to review first.`,
    {
      project: z.string(), keys: z.array(z.string()), new_key: z.string(), new_value: z.string(),
      new_category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional().default("fact"),
      preview_only: z.boolean().optional(),
    },
    async ({ project, keys, new_key, new_value, new_category, preview_only }) => {
      if (keys.length < 2) return err("compress requires at least 2 keys");
      const sources = memoryRepo.getMemoriesByKeys(project, keys);
      if (sources.length === 0) return err(`No memories found for keys: ${keys.join(", ")}`);
      if (preview_only) return { preview: true, project, source_memories: sources, hint: "Re-run without preview_only to execute." };

      const result = await compressMemories(project, keys, new_key, new_value, new_category ?? "fact");
      await embedMemory(result.newId);
      return withActions({
        compressed: true, project, deleted_keys: result.deletedKeys,
        new_memory: { key: new_key, category: new_category ?? "fact", importance: result.maxImportance },
        tokens_saved_estimate: estimateTokens(sources.map((m) => m.value).join("")),
      }, ["Run search() to verify compressed memory is retrievable"]);
    }
  );

  defineTextTool(
    server, "generate_rules",
    `Convert project memories into rules for AI tools.
WHEN: Generate CLAUDE.md, .cursor/rules, or AGENTS.md from stored knowledge.
Example: generate_rules("api", format="cursor")
format: claude (default) | cursor | agents`,
    {
      project: z.string(),
      format: z.enum(["claude", "cursor", "agents"]).optional().default("claude"),
      categories: z.array(z.enum(["rule", "warning", "pattern", "preference", "fact"])).optional(),
    },
    ({ project, format, categories }) => generateRules(project, format ?? "claude", categories)
  );

  defineTool(
    server, "token_budget",
    `Estimate tokens a full recall() would consume, with optimization suggestions.
WHEN: Recall feels expensive or project has many memories.
Example: token_budget("api") → total_estimated_tokens + suggestions.`,
    { project: z.string() },
    ({ project }) => {
      const { memories, sessions, tasks, decisions, staleCount } = memoryRepo.tokenBudgetRows(project);
      const sections = {
        memories: { count: memories.length, tokens: estimateTokens(JSON.stringify(memories)) },
        sessions: { count: sessions.length, tokens: estimateTokens(JSON.stringify(sessions)) },
        tasks: { count: tasks.length, tokens: estimateTokens(JSON.stringify(tasks)) },
        decisions: { count: decisions.length, tokens: estimateTokens(JSON.stringify(decisions)) },
      };
      const total = Object.values(sections).reduce((s, x) => s + x.tokens, 0);
      const suggestions: string[] = [];
      if (total > 5000 && sections.memories.count > 15) suggestions.push("Use session_start slim:true (~80% memory token cut)");
      if (sections.tasks.count > 20) suggestions.push("Mark completed tasks done");
      if (staleCount > 5) suggestions.push(`${staleCount} stale memories — clean(project,'archive')`);
      if (total > 8000) suggestions.push("Run health(project) for compression opportunities");
      return withActions(
        { project, total_estimated_tokens: total, sections, stale_memories: staleCount, ...(suggestions.length && { suggestions }), ...(total > 8000 && { warning: `High token usage (${total}).` }) },
        suggestions
      );
    }
  );
}
