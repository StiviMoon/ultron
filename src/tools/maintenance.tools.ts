// ── ULTRON v9 — maintenance tools (clean) ─────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err } from "../lib/result.js";
import { defineTool } from "../lib/define-tool.js";
import { withActions } from "../lib/next-actions.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import { truncate } from "../lib/result.js";

export function registerMaintenanceTools(server: McpServer): void {
  defineTool(
    server, "clean",
    `List/archive/delete stale memories (not accessed in N+ days).
WHEN: Project memory is bloated or health reports stale entries.
Example: clean("api", action="list") then clean("api", action="archive")
actions: list (preview) | archive (delete all stale) | delete (single key).`,
    { project: z.string(), action: z.enum(["list", "archive", "delete"]).optional().default("list"), key: z.string().optional(), days: z.number().optional().default(45) },
    ({ project, action, key, days }) => {
      const threshold = days ?? 45;
      const act = action ?? "list";
      if (act === "delete") {
        if (!key) return err("'key' is required for action=delete");
        const deleted = memoryRepo.deleteByKey(project, key);
        if (!deleted) return err(`No memory found with key '${key}'`);
        return withActions({ deleted: true, project, key }, ["Vector and graph links also removed"]);
      }
      const stale = memoryRepo.getStaleMemories(project, threshold);
      if (act === "archive") {
        if (stale.length === 0) return { archived: 0, message: `No stale memories (threshold ${threshold}d)` };
        const keys = stale.map((m) => m.key);
        const count = memoryRepo.deleteMemories(project, keys);
        return withActions({ archived: count, project, threshold_days: threshold, deleted_keys: keys }, ["Run health(project) to verify improvement"]);
      }
      return withActions({
        project, threshold_days: threshold, stale_count: stale.length,
        stale_memories: stale.map((m) => ({ key: m.key, category: m.category, last_accessed: m.last_accessed_at ?? "never", created_at: m.created_at, preview: truncate(m.value, 100) })),
        hint: stale.length > 0 ? `clean(project, action='archive') to delete all` : `Project is clean.`,
      }, stale.length > 0 ? ["Review stale_memories before archiving"] : []);
    }
  );
}
