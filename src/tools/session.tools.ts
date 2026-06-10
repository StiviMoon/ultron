// ── ULTRON v9 — session tools ───────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uuid } from "../db/connection.js";
import { err, text, now } from "../lib/result.js";
import { defineTool, defineTextTool } from "../lib/define-tool.js";
import { withActions, sessionStartActions } from "../lib/next-actions.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import * as sessionRepo from "../repositories/session.repo.js";
import * as taskRepo from "../repositories/task.repo.js";
import * as decisionRepo from "../repositories/decision.repo.js";
import * as projectRepo from "../repositories/project.repo.js";
import { fetchProjectContext } from "../services/recall.service.js";
import { embedMemory } from "../repositories/vector.repo.js";
import { getOnboardProtocol } from "../services/onboard.service.js";
import { truncate } from "../lib/result.js";

function parseJsonArray(s: string | null): string[] {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

export function registerSessionTools(server: McpServer): void {
  defineTool(
    server, "session_start",
    `Start a work session AND load full project context in one call.
WHEN: At the START of every work session — always call this first.
Example: session_start("api", "cursor", slim=true)
Returns: session_id, rules (first), warnings, tasks, decisions, snapshot.
Token tip: slim=true saves ~80% tokens. fields=["tasks"] loads subset only.`,
    {
      project: z.string(),
      tool: z.string(),
      slim: z.boolean().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
      diff_since: z.string().optional(),
    },
    ({ project, tool, slim, fields, diff_since }) => {
      const purged = memoryRepo.purgeExpired(project);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const staleClosed = sessionRepo.closeStale(project, twoHoursAgo);
      const sessionId = sessionRepo.open(project, tool);
      const context = fetchProjectContext(project, { slim, fields, since: diff_since });
      return withActions(
        {
          session_id: sessionId, started_at: now(),
          ...(purged > 0 && { auto_purged_expired: purged }),
          ...(staleClosed > 0 && { auto_closed_stale_sessions: staleClosed }),
          ...context,
        },
        sessionStartActions(context)
      );
    }
  );

  defineTool(
    server, "session_end",
    `Close the active session with a summary. Refreshes _snapshot memory.
WHEN: At the END of every work session — never skip this.
Example: session_end("api", "cursor", "finished auth module", ["src/auth.ts"])
Returns: closed:true + snapshot_saved:true.`,
    { project: z.string(), tool: z.string(), summary: z.string(), files: z.array(z.string()).optional() },
    async ({ project, tool, summary, files }) => {
      const open = sessionRepo.findOpen(project, tool);
      if (!open) return err(`No open session for '${project}' (${tool}). Use session_start first.`);
      sessionRepo.close(open.id, summary, files ?? []);

      const pendingTasks = taskRepo.topPending(project, 5);
      const topMemories = memoryRepo.getRecentKeys(project, 8);
      const snapshot = [
        `Last session (${tool}): ${summary}`,
        files?.length ? `Files: ${files.slice(0, 5).join(", ")}` : null,
        pendingTasks.length ? `Pending tasks: ${pendingTasks.map((t) => `[${t.priority}] ${t.text}`).join(" | ")}` : "No pending tasks",
        topMemories.length ? `Key knowledge: ${topMemories.join(", ")}` : null,
      ].filter(Boolean).join(" — ");

      const id = uuid();
      const savedId = memoryRepo.saveSnapshot(project, snapshot, tool, id);
      await embedMemory(savedId);

      return withActions(
        { closed: true, project, tool, summary, snapshot_saved: true },
        ["Next session_start will load this snapshot automatically"]
      );
    }
  );

  defineTool(
    server, "projects",
    `List all projects with stats: last session, pending tasks, memory + decision counts.
WHEN: Need overview of all projects or switching context.
Example: projects()
Returns: Sorted by most recent session.`,
    {},
    () => {
      const list = projectRepo.listWithStats();
      return withActions({ total: list.length, projects: list }, list.length > 1 ? ["Use session_start on the target project before working"] : []);
    }
  );

  defineTextTool(
    server, "handoff",
    `Generate markdown context block for Claude.ai / ChatGPT (no MCP).
WHEN: Need to paste project context into a web chat.
Example: handoff("api")
Returns: Markdown block ready to paste.`,
    { project: z.string() },
    ({ project }) => {
      const last = sessionRepo.lastClosed(project);
      const memories = memoryRepo.listForHandoff(project, 20);
      const tasks = taskRepo.pending(project);
      const decisions = decisionRepo.recent(project, 8);
      const date = new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

      let md = `## [ULTRON CONTEXT — ${project} — ${date}]\n\n> Generated by ULTRON Hub v9. Paste at the start of your conversation.\n\n`;
      if (last) {
        md += `### Last session (${last.tool})\n${truncate(last.summary ?? "No summary", 500)}\n`;
        const files = parseJsonArray(last.files);
        if (files.length) md += `**Files:** ${files.join(", ")}\n`;
        md += "\n";
      }
      if (memories.length) {
        const byCat: Record<string, typeof memories> = {};
        for (const m of memories) (byCat[m.category] ??= []).push(m);
        md += `### Project knowledge\n`;
        for (const [cat, items] of Object.entries(byCat)) {
          md += `\n**${cat[0].toUpperCase() + cat.slice(1)}:**\n`;
          for (const m of items) md += `- **${m.key}**: ${truncate(m.value, 400)}\n`;
        }
        md += "\n";
      }
      if (decisions.length) { md += `### Technical decisions\n`; for (const d of decisions) md += `- **${d.topic}** → ${d.choice} — ${truncate(d.reason, 200)}\n`; md += "\n"; }
      if (tasks.length) { md += `### Pending tasks\n`; for (const t of tasks) { const b = t.priority === "high" ? " [HIGH]" : t.priority === "low" ? " [LOW]" : ""; md += `- [ ] ${t.text}${b}\n`; } md += "\n"; }
      md += `---\n_ULTRON Hub v9_`;
      return md;
    }
  );

  defineTool(
    server, "onboard",
    `Learn how to use ULTRON in one call. Returns the full protocol for any AI agent.
WHEN: First time using ULTRON, or unsure which tool to call.
Example: onboard()
Returns: Workflow, categories, conventions, anti-patterns, all 25 tools.`,
    {},
    () => withActions(getOnboardProtocol(), ["Call session_start(project, tool) to begin working"])
  );
}
