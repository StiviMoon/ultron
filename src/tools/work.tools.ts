// ── ULTRON v9 — task + decision tools ─────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err } from "../lib/result.js";
import { defineTool } from "../lib/define-tool.js";
import { withActions, taskDoneActions } from "../lib/next-actions.js";
import * as taskRepo from "../repositories/task.repo.js";
import * as decisionRepo from "../repositories/decision.repo.js";

function parseTags(s: string): string[] { try { return JSON.parse(s || "[]"); } catch { return []; } }

export function registerWorkTools(server: McpServer): void {
  defineTool(
    server, "task",
    `Manage persistent backlog. actions: add | update | done | list | delete.
WHEN: Track work across sessions. done/update/delete accept UUID or 1-based position from list.
Example: task("api", "add", text="fix auth redirect", priority="high", tags=["auth"])
Position matches priority-sorted list (high first).`,
    {
      project: z.string(),
      action: z.enum(["add", "update", "done", "list", "delete"]),
      text: z.string().optional(),
      id: z.string().optional(),
      priority: z.enum(["high", "medium", "low"]).optional().default("medium"),
      newText: z.string().optional(),
      newPriority: z.enum(["high", "medium", "low"]).optional(),
      tags: z.array(z.string()).optional(),
      newTags: z.array(z.string()).optional(),
      filter_tag: z.string().optional(),
      tool: z.string().optional(),
    },
    ({ project, action, text, id, priority, newText, newPriority, tags, newTags, filter_tag, tool }) => {
      if (action === "add") {
        if (!text) return err("'text' is required for action=add");
        const newId = taskRepo.add(project, text, priority ?? "medium", tags ?? [], tool ?? "claude-code");
        return withActions({ added: true, id: newId, text, priority: priority ?? "medium", ...(tags?.length && { tags }) }, ["Use task list to see position for done/update"]);
      }
      if (action === "update") {
        if (!id) return err("'id' is required for action=update");
        if (!newText && !newPriority && !newTags) return err("'newText', 'newPriority', or 'newTags' required");
        const target = taskRepo.resolveId(project, id);
        if (!target) return err(`No task at position ${id} or ID not found.`);
        taskRepo.update(project, target, { text: newText, priority: newPriority, tags: newTags });
        return { updated: true, id: target, ...(newText && { text: newText }), ...(newPriority && { priority: newPriority }), ...(newTags && { tags: newTags }) };
      }
      if (action === "done" || action === "delete") {
        if (!id) return err(`'id' is required for action=${action}`);
        const target = taskRepo.resolveId(project, id);
        if (!target) return err(`No task at position ${id} or ID not found.`);
        if (action === "done") {
          taskRepo.markDone(project, target);
          const highPending = taskRepo.pending(project).filter((t) => t.priority === "high").length;
          return withActions({ done: true, id: target }, taskDoneActions(highPending));
        }
        taskRepo.remove(project, target);
        return { deleted: true, id: target };
      }
      const rows = taskRepo.all(project);
      let pending = rows.filter((t) => t.status === "pending");
      if (filter_tag) pending = pending.filter((t) => parseTags(t.tags).includes(filter_tag));
      const pendingMapped = pending.map((t, i) => ({ position: i + 1, id: t.id, text: t.text, priority: t.priority, ...(parseTags(t.tags).length > 0 && { tags: parseTags(t.tags) }) }));
      const done = rows.filter((t) => t.status === "done").map((t) => ({ id: t.id, text: t.text, done_at: t.done_at }));
      return { project, ...(filter_tag && { filter_tag }), pending: pendingMapped, done };
    }
  );

  defineTool(
    server, "decision",
    `Log an immutable technical/design decision. Never deleted — explains why code is the way it is.
WHEN: After choosing between alternatives (DB, auth, architecture).
Example: decision("api", "database", "PostgreSQL", "better Prisma support than MySQL")
Use supersedes to chain when a decision is replaced.`,
    {
      project: z.string(),
      topic: z.string(),
      choice: z.string(),
      reason: z.string(),
      tool: z.string().optional(),
      supersedes: z.string().optional().describe("ID of the decision this replaces"),
    },
    ({ project, topic, choice, reason, tool, supersedes }) => {
      const id = decisionRepo.add(project, topic, choice, reason, tool ?? "claude-code", supersedes);
      return withActions({ logged: true, id, project, topic, choice, ...(supersedes && { supersedes }) }, ["Use list_decisions to review decision history"]);
    }
  );

  defineTool(
    server, "list_decisions",
    `Full decision history with pagination. Decisions are immutable but chainable via supersedes.
WHEN: Need to understand past technical choices.
Example: list_decisions("api", limit=10)`,
    { project: z.string(), limit: z.number().optional().default(20), offset: z.number().optional().default(0) },
    ({ project, limit, offset }) => {
      const { total, rows } = decisionRepo.paginate(project, limit ?? 20, offset ?? 0);
      return {
        project, total, offset: offset ?? 0, limit: limit ?? 20,
        decisions: rows.map((d) => ({
          id: d.id, topic: d.topic, choice: d.choice, reason: d.reason,
          tool: d.tool, created_at: d.created_at, ...(d.supersedes && { supersedes: d.supersedes }),
        })),
      };
    }
  );
}
