// ── ULTRON v8 — task + decision tools ─────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, errOf } from "../lib/result.js";
import * as taskRepo from "../repositories/task.repo.js";
import * as decisionRepo from "../repositories/decision.repo.js";

function parseTags(s: string): string[] { try { return JSON.parse(s || "[]"); } catch { return []; } }

export function registerWorkTools(server: McpServer): void {
  server.tool(
    "task",
    `Manage the persistent backlog. actions: add | update | done | list | delete.
done/update/delete accept a UUID or a 1-based position from recall/list.`,
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
      try {
        if (action === "add") {
          if (!text) return err("'text' is required for action=add");
          const newId = taskRepo.add(project, text, priority ?? "medium", tags ?? [], tool ?? "claude-code");
          return ok({ added: true, id: newId, text, priority: priority ?? "medium", ...(tags?.length && { tags }) });
        }
        if (action === "update") {
          if (!id) return err("'id' is required for action=update");
          if (!newText && !newPriority && !newTags) return err("'newText', 'newPriority', or 'newTags' required");
          const target = taskRepo.resolveId(project, id);
          if (!target) return err(`No task at position ${id} or ID not found.`);
          taskRepo.update(project, target, { text: newText, priority: newPriority, tags: newTags });
          return ok({ updated: true, id: target, ...(newText && { text: newText }), ...(newPriority && { priority: newPriority }), ...(newTags && { tags: newTags }) });
        }
        if (action === "done" || action === "delete") {
          if (!id) return err(`'id' is required for action=${action}`);
          const target = taskRepo.resolveId(project, id);
          if (!target) return err(`No task at position ${id} or ID not found.`);
          if (action === "done") { taskRepo.markDone(project, target); return ok({ done: true, id: target }); }
          taskRepo.remove(project, target);
          return ok({ deleted: true, id: target });
        }
        // list
        const rows = taskRepo.all(project);
        let pending = rows.filter((t) => t.status === "pending");
        if (filter_tag) pending = pending.filter((t) => parseTags(t.tags).includes(filter_tag));
        const pendingMapped = pending.map((t, i) => ({ position: i + 1, id: t.id, text: t.text, priority: t.priority, ...(parseTags(t.tags).length > 0 && { tags: parseTags(t.tags) }) }));
        const done = rows.filter((t) => t.status === "done").map((t) => ({ id: t.id, text: t.text, done_at: t.done_at }));
        return ok({ project, ...(filter_tag && { filter_tag }), pending: pendingMapped, done });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "decision",
    `Log an immutable technical/design decision — never deleted. Explains why the code is the way it is.`,
    { project: z.string(), topic: z.string(), choice: z.string(), reason: z.string(), tool: z.string().optional() },
    ({ project, topic, choice, reason, tool }) => {
      try {
        const id = decisionRepo.add(project, topic, choice, reason, tool ?? "claude-code");
        return ok({ logged: true, id, project, topic, choice });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "list_decisions",
    `Full decision history with pagination. Decisions are immutable.`,
    { project: z.string(), limit: z.number().optional().default(20), offset: z.number().optional().default(0) },
    ({ project, limit, offset }) => {
      try {
        const { total, rows } = decisionRepo.paginate(project, limit ?? 20, offset ?? 0);
        return ok({ project, total, offset: offset ?? 0, limit: limit ?? 20, decisions: rows.map((d) => ({ topic: d.topic, choice: d.choice, reason: d.reason, tool: d.tool, created_at: d.created_at })) });
      } catch (e) { return err(errOf(e)); }
    }
  );
}
