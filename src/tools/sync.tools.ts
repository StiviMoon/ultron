// ── ULTRON v9 — sync tools (export/import) ────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err } from "../lib/result.js";
import { defineTool } from "../lib/define-tool.js";
import { withActions } from "../lib/next-actions.js";
import { exportProject, importProject } from "../repositories/sync.repo.js";
import { backfillEmbeddings } from "../repositories/vector.repo.js";

export function registerSyncTools(server: McpServer): void {
  defineTool(
    server, "export_project",
    `Export all project data as JSON (backup / cross-machine sync).
WHEN: Moving to another machine or creating a backup.
Example: export_project("api") → JSON with memories, tasks, decisions, links, agents.
Includes: memory_links, agents, agent_runs (v9+).`,
    { project: z.string() },
    ({ project }) => {
      const payload = exportProject(project);
      return withActions(payload, ["Copy JSON output, then import_project on target machine"]);
    }
  );

  defineTool(
    server, "import_project",
    `Import an exported JSON blob. strategy: merge (upsert newer) | replace (wipe then insert).
WHEN: Restoring backup or syncing from another machine.
Example: import_project('<json>', strategy="merge")
Post-import: embeddings are backfilled automatically.`,
    { data: z.string(), strategy: z.enum(["merge", "replace"]).optional().default("merge") },
    async ({ data: jsonStr, strategy }) => {
      let payload;
      try { payload = JSON.parse(jsonStr); } catch { return err("Invalid JSON."); }
      if (!payload.project || !payload.data) return err("Invalid export format.");
      const counts = importProject(payload, strategy ?? "merge");
      const embedded = await backfillEmbeddings(64);
      return withActions(
        { imported: true, project: payload.project, strategy: strategy ?? "merge", counts, embeddings_backfilled: embedded },
        ["Call session_start to verify imported context"]
      );
    }
  );
}
