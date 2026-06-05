// ── ULTRON v8 — session tools (session_start, session_end, projects, handoff) ──

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, uuid } from "../db/connection.js";
import { ok, err, errOf, text, now, truncate } from "../lib/result.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import * as sessionRepo from "../repositories/session.repo.js";
import * as taskRepo from "../repositories/task.repo.js";
import * as decisionRepo from "../repositories/decision.repo.js";
import { fetchProjectContext } from "../services/recall.service.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_start",
    `Start a work session AND load full project context (session_start + recall in one).
Rules always injected first. Memories relevance-ranked. Expired auto-purged.
Token control: slim, fields, diff_since.`,
    {
      project: z.string(),
      tool: z.string(),
      slim: z.boolean().optional(),
      fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional(),
      diff_since: z.string().optional(),
    },
    ({ project, tool, slim, fields, diff_since }) => {
      try {
        const purged = memoryRepo.purgeExpired(project);
        const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const staleClosed = sessionRepo.closeStale(project, twoHoursAgo);
        const sessionId = sessionRepo.open(project, tool);
        const context = fetchProjectContext(project, { slim, fields, since: diff_since });
        return ok({
          session_id: sessionId, started_at: now(),
          ...(purged > 0 && { auto_purged_expired: purged }),
          ...(staleClosed > 0 && { auto_closed_stale_sessions: staleClosed }),
          ...context,
        });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "session_end",
    `Close the active session with a summary. Records work + files and refreshes the _snapshot memory.`,
    { project: z.string(), tool: z.string(), summary: z.string(), files: z.array(z.string()).optional() },
    ({ project, tool, summary, files }) => {
      try {
        const open = sessionRepo.findOpen(project, tool);
        if (!open) return ok({ closed: false, warning: `No open session for '${project}' (${tool}). Use session_start first.`, project, tool });
        sessionRepo.close(open.id, summary, files ?? []);

        const pendingTasks = taskRepo.topPending(project, 5);
        const topMemories = db.prepare("SELECT key FROM memories WHERE project = ? AND key != '_snapshot' ORDER BY updated_at DESC LIMIT 8").all(project) as Array<{ key: string }>;
        const snapshot = [
          `Last session (${tool}): ${summary}`,
          files?.length ? `Files: ${files.slice(0, 5).join(", ")}` : null,
          pendingTasks.length ? `Pending tasks: ${pendingTasks.map((t) => `[${t.priority}] ${t.text}`).join(" | ")}` : "No pending tasks",
          topMemories.length ? `Key knowledge: ${topMemories.map((m) => m.key).join(", ")}` : null,
        ].filter(Boolean).join(" — ");

        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, tool, updated_at)
           VALUES (?, ?, '_snapshot', ?, 'note', ?, datetime('now'))
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, tool = excluded.tool, updated_at = excluded.updated_at`
        ).run(uuid(), project, snapshot, tool);

        return ok({ closed: true, project, tool, summary, snapshot_saved: true });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "projects",
    `List all projects with stats: last session, pending tasks, memory + decision counts.`,
    {},
    () => {
      try {
        const rows = db.prepare(
          `SELECT DISTINCT project FROM (SELECT project FROM memories UNION SELECT project FROM sessions UNION SELECT project FROM tasks UNION SELECT project FROM decisions)`
        ).all() as Array<{ project: string }>;
        const list = rows.map(({ project: p }) => {
          const last = sessionRepo.lastClosed(p);
          const c = (sql: string) => (db.prepare(sql).get(p) as { c: number } | undefined)?.c ?? 0;
          return {
            project: p,
            last_session: last ? { tool: last.tool, summary: truncate(last.summary ?? "", 150), ended_at: last.ended_at } : null,
            pending_tasks: c("SELECT COUNT(*) c FROM tasks WHERE project = ? AND status = 'pending'"),
            memories_count: c("SELECT COUNT(*) c FROM memories WHERE project = ?"),
            decisions_count: c("SELECT COUNT(*) c FROM decisions WHERE project = ?"),
          };
        });
        list.sort((a, b) => {
          if (!a.last_session) return 1;
          if (!b.last_session) return -1;
          return new Date(b.last_session.ended_at!).getTime() - new Date(a.last_session.ended_at!).getTime();
        });
        return ok({ total: list.length, projects: list });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "handoff",
    `Generate a markdown context block to paste into Claude.ai / ChatGPT (no MCP).`,
    { project: z.string() },
    ({ project }) => {
      try {
        const last = sessionRepo.lastClosed(project);
        const memories = db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 20").all(project) as Array<{ key: string; value: string; category: string }>;
        const tasks = taskRepo.pending(project);
        const decisions = decisionRepo.recent(project, 8);
        const date = new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

        let md = `## [ULTRON CONTEXT — ${project} — ${date}]\n\n> Generated by ULTRON Hub v8. Paste at the start of your conversation.\n\n`;
        if (last) {
          md += `### Last session (${last.tool})\n${truncate(last.summary ?? "No summary", 500)}\n`;
          const files = (() => { try { return JSON.parse(last.files || "[]"); } catch { return []; } })();
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
        md += `---\n_ULTRON Hub v8_`;
        return text(md);
      } catch (e) { return err(errOf(e)); }
    }
  );
}
