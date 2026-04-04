/**
 * ULTRON Hub — MCP Server v5
 *
 * Persistent developer memory for Claude Code, Cursor, and any MCP client.
 * Local SQLite, zero config, installable with: npm install -g ultron-hub
 *
 * Tools (16):
 *   recall           — load full project context; supports slim mode and field filters
 *   remember         — save persistent key-value knowledge + expires_at
 *   note             — quick thought (auto-generated key from text)
 *   forget           — delete a memory by key
 *   search           — full-text search across memories, decisions, tasks; multi-project
 *   task             — backlog management (add | update | done | list | delete)
 *   decision         — immutable technical decision log
 *   list_decisions   — full decision history with pagination
 *   projects         — list all projects with stats
 *   session_start    — start session + auto recall
 *   session_end      — close session with summary
 *   handoff          — generate markdown context for Claude.ai / ChatGPT
 *   generate_rules   — convert warning/pattern memories into CLAUDE.md rules
 *   token_budget     — estimate token consumption per project
 *   export_project   — export project data as JSON for sync between machines
 *   import_project   — import JSON data with merge or replace strategy
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db, uuid } from "./db.js";
import { ok, text, err, errOf, now, truncate, estimateTokens } from "./helpers.js";

// ── Types ───────────────────────────────────────────────────────────────────
type ContextField = "sessions" | "memories" | "tasks" | "decisions";

interface FetchContextOptions {
  slim?: boolean;
  maxValueLength?: number;
  fields?: ContextField[];
}

// ── Shared context loader ───────────────────────────────────────────────────
function fetchProjectContext(project: string, options: FetchContextOptions = {}) {
  const { slim = false, maxValueLength = 1500, fields } = options;
  const loadAll = !fields || fields.length === 0;
  const load = (f: ContextField) => loadAll || (fields?.includes(f) ?? false);

  // Sessions
  const sessions = load("sessions")
    ? db.prepare(
        "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5"
      ).all(project) as any[]
    : null;

  // Memories
  const memories = load("memories")
    ? db.prepare(
        "SELECT * FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30"
      ).all(project) as any[]
    : null;

  // Tasks (ordered by priority)
  const tasks = load("tasks")
    ? db.prepare(
        `SELECT * FROM tasks WHERE project = ? AND status = 'pending'
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
                  created_at ASC`
      ).all(project) as any[]
    : null;

  // Decisions
  const decisions = load("decisions")
    ? db.prepare(
        "SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10"
      ).all(project) as any[]
    : null;

  // Update last_accessed_at for returned memories
  if (memories && memories.length > 0) {
    const ids = memories.map((m: any) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE memories SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(...ids);
  }

  const lastSession = sessions?.[0] ?? null;
  const nowMs = Date.now();

  // Process memories
  const processedMemories = memories
    ? memories.map((m: any) => {
        const expired = m.expires_at && new Date(m.expires_at).getTime() < nowMs;
        if (slim) {
          return { key: m.key, category: m.category, ...(expired && { expired: true }) };
        }
        return {
          key:      m.key,
          value:    truncate(m.value ?? "", maxValueLength),
          category: m.category,
          ...(expired && { expired: true }),
          ...(m.expires_at && !expired && { expires_at: m.expires_at }),
          ...(m.value?.length > maxValueLength && { truncated: true }),
        };
      })
    : null;

  return {
    project,
    retrieved_at: now(),
    ...(slim && { note: "slim mode — memories without values. Use full recall if you need values." }),
    last_session: lastSession
      ? {
          tool:     lastSession.tool,
          summary:  truncate(lastSession.summary ?? "", 400),
          files:    JSON.parse(lastSession.files || "[]"),
          ended_at: lastSession.ended_at,
        }
      : null,
    recent_sessions: sessions
      ? sessions.slice(1, 5).map((s: any) => ({
          tool:     s.tool,
          summary:  truncate(s.summary ?? "", 200),
          ended_at: s.ended_at,
        }))
      : undefined,
    memories: processedMemories ?? undefined,
    pending_tasks: tasks
      ? tasks.map((t: any, i: number) => ({
          position: i + 1,
          id:       t.id,
          text:     t.text,
          priority: t.priority ?? "medium",
        }))
      : undefined,
    recent_decisions: decisions
      ? decisions.map((d: any) => ({
          topic:  d.topic,
          choice: d.choice,
          reason: truncate(d.reason ?? "", 300),
        }))
      : undefined,
  };
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name:    "ultron-hub",
  version: "5.0.0",
});

// ── TOOL: recall ────────────────────────────────────────────────────────────
server.tool(
  "recall",
  `Load full project context: last session, memories (knowledge base), pending tasks, and technical decisions.
Use at session start to resume where you left off.
Pending tasks include position (1, 2, 3...) so you can mark them done without needing the UUID.

Optional parameters for token control:
  - slim: true = memories return only key+category (no values). Saves ~80% tokens.
  - maxValueLength: truncate memory values (default: 1500 chars)
  - fields: load only specific sections ["sessions", "memories", "tasks", "decisions"]`,
  {
    project:        z.string().describe("Project name. Ex: 'vendly', 'lukapp', 'mj'"),
    slim:           z.boolean().optional().describe("If true, memories return only key+category. Saves tokens."),
    maxValueLength: z.number().optional().describe("Truncate memory values to this many characters (default: 1500)"),
    fields:         z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional()
                     .describe("Only load these sections. Omit to load everything."),
  },
  ({ project, slim, maxValueLength, fields }) => {
    try {
      return ok(fetchProjectContext(project, { slim, maxValueLength, fields }));
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: remember ──────────────────────────────────────────────────────────
server.tool(
  "remember",
  `Save or update persistent key-value knowledge for a project.
If the key already exists, it upserts (updates the value).
Categories:
  - fact        — concrete data: stack, URLs, versions
  - pattern     — code or architecture patterns to follow
  - preference  — team or developer preferences
  - warning     — things to avoid, known bugs, gotchas
  - note        — free-form observations`,
  {
    project:    z.string().describe("Project name"),
    key:        z.string().describe("Unique identifier. Ex: 'stack-frontend', 'api-base-url'"),
    value:      z.string().describe("The knowledge to save"),
    category:   z.enum(["fact", "pattern", "preference", "warning", "note"])
                 .default("fact")
                 .describe("Type of knowledge"),
    expires_at: z.string().optional()
                 .describe("Optional ISO expiration date. Ex: '2026-06-01'. After this date the memory shows as [EXPIRED]."),
    tool:       z.string().optional().describe("Tool saving this. Ex: 'claude-code', 'cursor'"),
  },
  ({ project, key, value, category, expires_at, tool }) => {
    try {
      if (value.length > 10000) {
        return err("Value exceeds 10,000 character limit. Save only essential information.");
      }

      // Duplicate detection
      const firstSegment = key.split("-")[0];
      const similar = db.prepare(
        "SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?"
      ).all(project, key, `${firstSegment}-%`) as any[];

      const warnings: string[] = [];
      if (similar.length > 0) {
        warnings.push(
          `Similar keys exist in '${project}': ${similar.map((m: any) => `'${m.key}'`).join(", ")}. ` +
          `Consider updating one of those instead of creating a new memory.`
        );
      }
      if (value.length > 600) {
        warnings.push(
          `Long value (${value.length} chars, recommended <600). ` +
          `If this is a full plan or spec, save it as a .md file and reference the path here.`
        );
      }

      const id = uuid();
      db.prepare(
        `INSERT INTO memories (id, project, key, value, category, tool, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, key) DO UPDATE SET
           value = excluded.value,
           category = excluded.category,
           tool = excluded.tool,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`
      ).run(id, project, key, value, category, tool ?? "claude-code", now(), expires_at ?? null);

      return ok({
        saved: true,
        project, key, category, value,
        ...(expires_at && { expires_at }),
        ...(warnings.length > 0 && { warnings }),
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: note ──────────────────────────────────────────────────────────────
server.tool(
  "note",
  `Save a quick thought without needing to define an explicit key.
Shortcut for remember with category=note and auto-generated key.
Useful for quick observations, ideas, or notes during work.`,
  {
    project: z.string().describe("Project name"),
    text:    z.string().describe("The thought or note to save"),
    tool:    z.string().optional(),
  },
  ({ project, text: noteText, tool }) => {
    try {
      const slug = noteText.trim().toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 40)
        .replace(/-+$/, "");
      const key = `note-${slug || Date.now()}`;

      const id = uuid();
      db.prepare(
        "INSERT INTO memories (id, project, key, value, category, tool) VALUES (?, ?, ?, ?, 'note', ?)"
      ).run(id, project, key, noteText, tool ?? "claude-code");

      return ok({ saved: true, project, key });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: forget ────────────────────────────────────────────────────────────
server.tool(
  "forget",
  `Delete a specific memory from a project by its key.
Use to clean up outdated or incorrect knowledge.
Use recall or search first to see available keys.`,
  {
    project: z.string().describe("Project name"),
    key:     z.string().describe("Exact key of the memory to delete"),
  },
  ({ project, key }) => {
    try {
      const result = db.prepare(
        "DELETE FROM memories WHERE project = ? AND key = ?"
      ).run(project, key);

      if (result.changes === 0) return err(`No memory found with key '${key}' in project '${project}'`);
      return ok({ deleted: true, project, key });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: search ────────────────────────────────────────────────────────────
server.tool(
  "search",
  `Search by text across memories, decisions, and/or tasks.
Uses full-text search (FTS5) for memories — fast and ranked by relevance.

scope controls where to search (default: memories only):
  - "memories"  — searches key and value (FTS5)
  - "decisions" — searches topic, choice, and reason
  - "tasks"     — searches task text`,
  {
    project:  z.string().describe("Base project name"),
    query:    z.string().describe("Text to search for"),
    scope:    z.array(z.enum(["memories", "decisions", "tasks"]))
               .optional()
               .describe("Where to search (default: ['memories'])"),
    projects: z.array(z.string()).optional()
               .describe("Projects to search. Default: base project only. Use ['all'] for all projects."),
  },
  ({ project, query, scope, projects }) => {
    try {
      const searchIn = scope && scope.length > 0 ? scope : ["memories"];

      // Resolve target projects
      let targetProjects: string[];
      if (projects && projects.includes("all")) {
        const allProjs = db.prepare("SELECT DISTINCT project FROM memories").all() as any[];
        const allSet = new Set<string>([project, ...allProjs.map((r: any) => r.project)]);
        targetProjects = Array.from(allSet);
      } else if (projects && projects.length > 0) {
        targetProjects = [...new Set([project, ...projects])];
      } else {
        targetProjects = [project];
      }

      const multiProject = targetProjects.length > 1;
      const results: Record<string, unknown[]> = {};
      const placeholders = targetProjects.map(() => "?").join(",");

      // Search memories with FTS5
      if (searchIn.includes("memories")) {
        let rows: any[];
        try {
          rows = db.prepare(
            `SELECT m.id, m.project, m.key, m.value, m.category, m.updated_at
             FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE fts.memories_fts MATCH ?
             AND m.project IN (${placeholders})
             ORDER BY fts.rank
             LIMIT 20`
          ).all(query, ...targetProjects);
        } catch {
          // FTS parse error — fallback to LIKE
          rows = db.prepare(
            `SELECT id, project, key, value, category, updated_at
             FROM memories
             WHERE project IN (${placeholders})
             AND (key LIKE ? OR value LIKE ?)
             ORDER BY updated_at DESC
             LIMIT 20`
          ).all(...targetProjects, `%${query}%`, `%${query}%`);
        }

        // Update last_accessed_at for found memories
        if (rows.length > 0) {
          const ids = rows.map((r: any) => r.id);
          const idPlaceholders = ids.map(() => "?").join(",");
          db.prepare(
            `UPDATE memories SET last_accessed_at = datetime('now') WHERE id IN (${idPlaceholders})`
          ).run(...ids);
        }

        results.memories = rows.map((m: any) => ({
          ...(multiProject && { project: m.project }),
          key: m.key,
          value: truncate(m.value ?? "", 600),
          category: m.category,
        }));
      }

      // Search decisions
      if (searchIn.includes("decisions")) {
        const rows = db.prepare(
          `SELECT project, topic, choice, reason, created_at
           FROM decisions
           WHERE project IN (${placeholders})
           AND (topic LIKE ? OR choice LIKE ? OR reason LIKE ?)
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(...targetProjects, `%${query}%`, `%${query}%`, `%${query}%`) as any[];

        results.decisions = rows.map((d: any) => ({
          ...(multiProject && { project: d.project }),
          topic: d.topic, choice: d.choice, reason: d.reason,
        }));
      }

      // Search tasks
      if (searchIn.includes("tasks")) {
        const rows = db.prepare(
          `SELECT project, id, text, status, priority, created_at
           FROM tasks
           WHERE project IN (${placeholders})
           AND text LIKE ?
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(...targetProjects, `%${query}%`) as any[];

        results.tasks = rows.map((t: any) => ({
          ...(multiProject && { project: t.project }),
          id: t.id, text: t.text, status: t.status, priority: t.priority,
        }));
      }

      const totalFound = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);

      return ok({
        project,
        searched_projects: targetProjects,
        query,
        scope: searchIn,
        total_found: totalFound,
        results,
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: task ──────────────────────────────────────────────────────────────
server.tool(
  "task",
  `Manage the persistent project backlog.
Actions:
  - add    — add a new task (requires: text, optional: priority)
  - update — edit text and/or priority of an existing task (requires: id, optional: newText, newPriority)
  - done   — mark a task as completed (requires: id as UUID or position 1, 2, 3...)
  - delete — permanently delete a task (requires: id as UUID or position)
  - list   — list all tasks (pending and completed)
Positions (1, 2, 3...) come from recall or task list results.`,
  {
    project:     z.string().describe("Project name"),
    action:      z.enum(["add", "update", "done", "list", "delete"]).describe("Operation to perform"),
    text:        z.string().optional().describe("Task text — only for action=add"),
    id:          z.string().optional().describe("UUID or position (1, 2, 3...) — for action=done, update, or delete"),
    priority:    z.enum(["high", "medium", "low"]).optional().default("medium")
                  .describe("Task priority — for action=add"),
    newText:     z.string().optional().describe("New task text — only for action=update"),
    newPriority: z.enum(["high", "medium", "low"]).optional()
                  .describe("New priority — only for action=update"),
    tool:        z.string().optional(),
  },
  ({ project, action, text: taskText, id, priority, newText, newPriority, tool }) => {
    try {
      // Resolve numeric position → UUID
      function resolveId(rawId: string): string | null {
        const pos = parseInt(rawId);
        if (!isNaN(pos) && String(pos) === rawId) {
          const pending = db.prepare(
            "SELECT id FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC"
          ).all(project) as any[];
          return pending[pos - 1]?.id ?? null;
        }
        return rawId;
      }

      // ADD
      if (action === "add") {
        if (!taskText) return err("'text' is required for action=add");
        const id = uuid();
        db.prepare(
          "INSERT INTO tasks (id, project, text, priority, tool) VALUES (?, ?, ?, ?, ?)"
        ).run(id, project, taskText, priority ?? "medium", tool ?? "claude-code");
        return ok({ added: true, id, text: taskText, priority: priority ?? "medium" });
      }

      // UPDATE
      if (action === "update") {
        if (!id) return err("'id' is required for action=update");
        if (!newText && !newPriority) return err("'newText' or 'newPriority' required for action=update");

        const targetId = resolveId(id);
        if (!targetId) return err(`No task at position ${id} or ID not found.`);

        const sets: string[] = [];
        const vals: any[] = [];
        if (newText) { sets.push("text = ?"); vals.push(newText); }
        if (newPriority) { sets.push("priority = ?"); vals.push(newPriority); }
        vals.push(targetId, project);

        db.prepare(
          `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project = ?`
        ).run(...vals);

        return ok({ updated: true, id: targetId, ...(newText && { text: newText }), ...(newPriority && { priority: newPriority }) });
      }

      // DONE / DELETE
      if (action === "done" || action === "delete") {
        if (!id) return err(`'id' is required for action=${action}`);

        const targetId = resolveId(id);
        if (!targetId) return err(`No task at position ${id} or ID not found.`);

        if (action === "done") {
          db.prepare(
            "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND project = ?"
          ).run(now(), targetId, project);
          return ok({ done: true, id: targetId });
        }

        db.prepare("DELETE FROM tasks WHERE id = ? AND project = ?").run(targetId, project);
        return ok({ deleted: true, id: targetId });
      }

      // LIST
      if (action === "list") {
        const rows = db.prepare(
          "SELECT id, text, status, priority, created_at, done_at, tool FROM tasks WHERE project = ? ORDER BY created_at ASC"
        ).all(project) as any[];

        const pending = rows
          .filter((t: any) => t.status === "pending")
          .map((t: any, i: number) => ({ position: i + 1, id: t.id, text: t.text, priority: t.priority }));
        const done = rows
          .filter((t: any) => t.status === "done")
          .map((t: any) => ({ id: t.id, text: t.text, done_at: t.done_at }));

        return ok({ project, pending, done });
      }

      return err("Invalid action");
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: decision ──────────────────────────────────────────────────────────
server.tool(
  "decision",
  `Log a technical or design decision in an immutable record — never deleted.
Use when choosing a technology, pattern, or approach over alternatives.
The decision history helps any model understand why the code is the way it is.`,
  {
    project: z.string().describe("Project name"),
    topic:   z.string().describe("Decision topic. Ex: 'database', 'auth', 'ui-framework', 'deploy'"),
    choice:  z.string().describe("What you chose. Ex: 'Supabase', 'JWT', 'Tailwind CSS', 'Render'"),
    reason:  z.string().describe("Why you chose it. Be specific — include discarded alternatives if applicable."),
    tool:    z.string().optional(),
  },
  ({ project, topic, choice, reason, tool }) => {
    try {
      const id = uuid();
      db.prepare(
        "INSERT INTO decisions (id, project, topic, choice, reason, tool) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, project, topic, choice, reason, tool ?? "claude-code");
      return ok({ logged: true, id, project, topic, choice });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: list_decisions ────────────────────────────────────────────────────
server.tool(
  "list_decisions",
  `List the full history of technical decisions for a project with pagination.
Unlike recall (which shows only the 10 most recent), here you can see all decisions.
Decisions are immutable — never deleted. They are the definitive record of why the code is the way it is.`,
  {
    project: z.string().describe("Project name"),
    limit:   z.number().optional().default(20).describe("Max decisions to return (default: 20)"),
    offset:  z.number().optional().default(0).describe("Pagination offset (default: 0)"),
  },
  ({ project, limit, offset }) => {
    try {
      const lim = limit ?? 20;
      const off = offset ?? 0;

      const count = (db.prepare(
        "SELECT COUNT(*) as total FROM decisions WHERE project = ?"
      ).get(project) as any)?.total ?? 0;

      const rows = db.prepare(
        "SELECT topic, choice, reason, tool, created_at FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).all(project, lim, off);

      return ok({ project, total: count, offset: off, limit: lim, decisions: rows });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: projects ──────────────────────────────────────────────────────────
server.tool(
  "projects",
  `List all projects registered in ULTRON with statistics:
last session, pending tasks, memory count, and decision count.
Use to discover what projects exist before running recall,
or for a general overview of all project states.`,
  {},
  () => {
    try {
      // Get all distinct projects
      const projectRows = db.prepare(
        `SELECT DISTINCT project FROM (
           SELECT project FROM memories
           UNION SELECT project FROM sessions
           UNION SELECT project FROM tasks
           UNION SELECT project FROM decisions
         )`
      ).all() as any[];

      const projectList = projectRows.map((row: any) => {
        const p = row.project;

        const lastSession = db.prepare(
          "SELECT tool, summary, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
        ).get(p) as any;

        const memoriesCount = (db.prepare(
          "SELECT COUNT(*) as c FROM memories WHERE project = ?"
        ).get(p) as any)?.c ?? 0;

        const pendingCount = (db.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE project = ? AND status = 'pending'"
        ).get(p) as any)?.c ?? 0;

        const decisionsCount = (db.prepare(
          "SELECT COUNT(*) as c FROM decisions WHERE project = ?"
        ).get(p) as any)?.c ?? 0;

        return {
          project: p,
          last_session: lastSession
            ? { tool: lastSession.tool, summary: truncate(lastSession.summary ?? "", 150), ended_at: lastSession.ended_at }
            : null,
          pending_tasks:   pendingCount,
          memories_count:  memoriesCount,
          decisions_count: decisionsCount,
        };
      });

      // Sort by most recent session
      projectList.sort((a, b) => {
        if (!a.last_session) return 1;
        if (!b.last_session) return -1;
        return new Date(b.last_session.ended_at).getTime() - new Date(a.last_session.ended_at).getTime();
      });

      return ok({ total: projectList.length, projects: projectList });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: session_start ─────────────────────────────────────────────────────
server.tool(
  "session_start",
  `Register the start of a work session AND automatically load the full project context.
Equivalent to session_start + recall in one step.
Call at the beginning of work — returns everything needed to resume.

Optional parameters for token control:
  - slim: true = memories without values (keys only). Useful when the project has many memories.
  - fields: load only specific sections ["sessions", "memories", "tasks", "decisions"]`,
  {
    project: z.string().describe("Project name"),
    tool:    z.string().describe("Current tool. Ex: 'claude-code', 'cursor'"),
    slim:    z.boolean().optional().describe("If true, memories return only key+category (no values)."),
    fields:  z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional()
              .describe("Only load these sections. Omit to load everything."),
  },
  ({ project, tool, slim, fields }) => {
    try {
      // Auto-close stale sessions (open >2h)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      db.prepare(
        `UPDATE sessions SET ended_at = ?, summary = 'Auto-closed — stale session (>2h without session_end)'
         WHERE project = ? AND ended_at IS NULL AND started_at < ?`
      ).run(now(), project, twoHoursAgo);

      // Create new session
      const sessionId = uuid();
      db.prepare(
        "INSERT INTO sessions (id, project, tool) VALUES (?, ?, ?)"
      ).run(sessionId, project, tool);

      // Load context
      const context = fetchProjectContext(project, { slim, fields });

      return ok({
        session_id: sessionId,
        started_at: now(),
        ...context,
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: session_end ───────────────────────────────────────────────────────
server.tool(
  "session_end",
  `Close the active session with a summary of what was done.
Call when finishing work — records what was done and what files were touched
so the next session can resume from here.`,
  {
    project: z.string().describe("Project name"),
    tool:    z.string().describe("Current tool"),
    summary: z.string().describe("Clear summary of what was done this session. Be specific."),
    files:   z.array(z.string()).optional().describe("Main files created or modified this session"),
  },
  ({ project, tool, summary, files }) => {
    try {
      const openSession = db.prepare(
        "SELECT id FROM sessions WHERE project = ? AND tool = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
      ).get(project, tool) as any;

      if (!openSession) {
        return ok({
          closed: false,
          warning: `No open session found for '${project}' (${tool}). Use session_start at the beginning of each work session.`,
          project, tool,
        });
      }

      db.prepare(
        "UPDATE sessions SET summary = ?, files = ?, ended_at = ? WHERE id = ?"
      ).run(summary, JSON.stringify(files ?? []), now(), openSession.id);

      return ok({ closed: true, project, tool, summary });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: handoff ───────────────────────────────────────────────────────────
server.tool(
  "handoff",
  `Generate a markdown context block ready to paste into Claude.ai, ChatGPT, or any tool without MCP.
Includes: last session, project knowledge, technical decisions, and pending tasks.
Copy the result and paste it at the start of your conversation in the target tool.`,
  { project: z.string().describe("Project name") },
  ({ project }) => {
    try {
      const lastSession = db.prepare(
        "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
      ).get(project) as any;

      const memories = db.prepare(
        "SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 20"
      ).all(project) as any[];

      const tasks = db.prepare(
        "SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC"
      ).all(project) as any[];

      const decisions = db.prepare(
        "SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 8"
      ).all(project) as any[];

      const date = new Date().toLocaleDateString("en-US", {
        day: "numeric", month: "long", year: "numeric",
      });

      let md = `## [ULTRON CONTEXT — ${project} — ${date}]\n\n`;
      md += `> Generated by ULTRON Hub v5. Paste this at the start of your conversation.\n\n`;

      if (lastSession) {
        md += `### Last session (${lastSession.tool})\n`;
        md += `${truncate(lastSession.summary ?? "No summary", 500)}\n`;
        const files = JSON.parse(lastSession.files || "[]");
        if (files.length) {
          md += `**Files:** ${files.join(", ")}\n`;
        }
        md += "\n";
      }

      if (memories.length) {
        const byCategory: Record<string, typeof memories> = {};
        for (const m of memories) {
          byCategory[m.category] = byCategory[m.category] ?? [];
          byCategory[m.category].push(m);
        }

        md += `### Project knowledge\n`;
        for (const [cat, items] of Object.entries(byCategory)) {
          md += `\n**${cat.charAt(0).toUpperCase() + cat.slice(1)}:**\n`;
          for (const m of items) {
            md += `- **${m.key}**: ${truncate(m.value ?? "", 400)}\n`;
          }
        }
        md += "\n";
      }

      if (decisions.length) {
        md += `### Technical decisions\n`;
        for (const d of decisions) {
          md += `- **${d.topic}** → ${d.choice} — ${truncate(d.reason ?? "", 200)}\n`;
        }
        md += "\n";
      }

      if (tasks.length) {
        md += `### Pending tasks\n`;
        for (const t of tasks) {
          const badge = t.priority === "high" ? " [HIGH]" : t.priority === "low" ? " [LOW]" : "";
          md += `- [ ] ${t.text}${badge}\n`;
        }
        md += "\n";
      }

      md += `---\n_ULTRON Hub v5_`;

      return text(md);
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: generate_rules ────────────────────────────────────────────────────
server.tool(
  "generate_rules",
  `Convert project memories (warnings, patterns, preferences) into CLAUDE.md-compatible rules.
Returns markdown ready to paste into your project's CLAUDE.md file.
The rules are extracted from real experience stored in ULTRON — specific to YOUR failure modes, not generic advice.`,
  {
    project:    z.string().describe("Project name"),
    categories: z.array(z.enum(["warning", "pattern", "preference", "fact"]))
                 .optional()
                 .describe("Categories to include. Default: ['warning', 'pattern', 'preference']"),
  },
  ({ project, categories }) => {
    try {
      const cats = categories && categories.length > 0
        ? categories
        : ["warning", "pattern", "preference"];

      const placeholders = cats.map(() => "?").join(",");
      const memories = db.prepare(
        `SELECT key, value, category FROM memories
         WHERE project = ? AND category IN (${placeholders})
         ORDER BY category, key`
      ).all(project, ...cats) as any[];

      if (memories.length === 0) {
        return text(`No memories found in categories [${cats.join(", ")}] for project '${project}'.\nUse remember() to store warnings and patterns as you work.`);
      }

      // Group by category
      const grouped: Record<string, any[]> = {};
      for (const m of memories) {
        grouped[m.category] = grouped[m.category] ?? [];
        grouped[m.category].push(m);
      }

      let md = `# Project Rules: ${project}\n`;
      md += `# Generated by ULTRON Hub — paste into your project's CLAUDE.md\n\n`;

      if (grouped.warning) {
        md += `## Avoid\n`;
        md += `<!-- Things to watch out for — learned from real experience -->\n\n`;
        for (const m of grouped.warning) {
          md += `- ${m.value}\n`;
        }
        md += "\n";
      }

      if (grouped.pattern) {
        md += `## Follow\n`;
        md += `<!-- Architecture and code patterns that work in this project -->\n\n`;
        for (const m of grouped.pattern) {
          md += `- ${m.value}\n`;
        }
        md += "\n";
      }

      if (grouped.preference) {
        md += `## Preferences\n`;
        md += `<!-- Team conventions and style rules -->\n\n`;
        for (const m of grouped.preference) {
          md += `- ${m.value}\n`;
        }
        md += "\n";
      }

      if (grouped.fact) {
        md += `## Facts\n`;
        md += `<!-- Key project data -->\n\n`;
        for (const m of grouped.fact) {
          md += `- **${m.key}**: ${m.value}\n`;
        }
        md += "\n";
      }

      md += `---\n`;
      md += `_Generated by ULTRON Hub v5 on ${new Date().toISOString().split("T")[0]}_\n`;

      return text(md);
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: token_budget ──────────────────────────────────────────────────────
server.tool(
  "token_budget",
  `Estimate how many tokens a full recall() for this project would consume.
Broken down by section (memories, sessions, tasks, decisions).
Suggests optimizations if token usage is high.`,
  {
    project: z.string().describe("Project name"),
  },
  ({ project }) => {
    try {
      const memories = db.prepare(
        "SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30"
      ).all(project) as any[];

      const sessions = db.prepare(
        "SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5"
      ).all(project) as any[];

      const tasks = db.prepare(
        "SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'"
      ).all(project) as any[];

      const decisions = db.prepare(
        "SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10"
      ).all(project) as any[];

      // Stale memories (not accessed in 45+ days)
      const staleCount = (db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ?
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-45 days'))`
      ).get(project) as any)?.c ?? 0;

      const sections = {
        memories:  { count: memories.length,  tokens: estimateTokens(JSON.stringify(memories)) },
        sessions:  { count: sessions.length,  tokens: estimateTokens(JSON.stringify(sessions)) },
        tasks:     { count: tasks.length,     tokens: estimateTokens(JSON.stringify(tasks)) },
        decisions: { count: decisions.length, tokens: estimateTokens(JSON.stringify(decisions)) },
      };

      const total = Object.values(sections).reduce((sum, s) => sum + s.tokens, 0);

      const suggestions: string[] = [];
      if (total > 5000 && memories.length > 15) {
        suggestions.push("Use recall with slim:true to reduce memory tokens by ~80%");
      }
      if (tasks.length > 20) {
        suggestions.push("Mark completed tasks as done to reduce task count");
      }
      if (staleCount > 5) {
        suggestions.push(`${staleCount} memories not accessed in 45+ days — consider cleaning with forget()`);
      }
      if (total > 8000) {
        suggestions.push("Use fields:['memories','tasks'] to skip sessions/decisions in recall");
      }

      return ok({
        project,
        total_estimated_tokens: total,
        sections,
        stale_memories: staleCount,
        ...(suggestions.length > 0 && { suggestions }),
        ...(total > 8000 && { warning: `High token usage (${total} estimated). Consider optimizations above.` }),
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: export_project ────────────────────────────────────────────────────
server.tool(
  "export_project",
  `Export all data for a project as a JSON blob.
Use for backups or to sync data between machines.
Import with import_project on another machine.`,
  {
    project: z.string().describe("Project name to export"),
  },
  ({ project }) => {
    try {
      const memories  = db.prepare("SELECT * FROM memories WHERE project = ?").all(project);
      const sessions  = db.prepare("SELECT * FROM sessions WHERE project = ?").all(project);
      const decisions = db.prepare("SELECT * FROM decisions WHERE project = ?").all(project);
      const tasks     = db.prepare("SELECT * FROM tasks WHERE project = ?").all(project);

      return ok({
        ultron_version: "5.0.0",
        exported_at: now(),
        project,
        counts: {
          memories:  memories.length,
          sessions:  sessions.length,
          decisions: decisions.length,
          tasks:     tasks.length,
        },
        data: { memories, sessions, decisions, tasks },
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── TOOL: import_project ────────────────────────────────────────────────────
server.tool(
  "import_project",
  `Import a previously exported JSON blob, merging into the local database.
Strategies:
  - merge   — upsert memories (keep newer by updated_at), INSERT OR IGNORE for sessions/decisions/tasks
  - replace — delete ALL project data first, then insert everything fresh`,
  {
    data:     z.string().describe("JSON string from a previous export_project() call"),
    strategy: z.enum(["merge", "replace"]).optional().default("merge")
               .describe("'merge' = upsert keeping newer data, 'replace' = delete all then insert"),
  },
  ({ data: jsonStr, strategy }) => {
    try {
      const payload = JSON.parse(jsonStr);
      if (!payload.project || !payload.data) {
        return err("Invalid export format. Expected { project, data: { memories, sessions, decisions, tasks } }");
      }

      const { project, data } = payload;
      const strat = strategy ?? "merge";

      const importTx = db.transaction(() => {
        const counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0 };

        if (strat === "replace") {
          db.prepare("DELETE FROM memories WHERE project = ?").run(project);
          db.prepare("DELETE FROM sessions WHERE project = ?").run(project);
          db.prepare("DELETE FROM decisions WHERE project = ?").run(project);
          db.prepare("DELETE FROM tasks WHERE project = ?").run(project);
        }

        // Memories: upsert with timestamp comparison
        const memStmt = db.prepare(
          `INSERT INTO memories (id, project, key, value, category, tool, expires_at, last_accessed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, key) DO UPDATE SET
             value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
             category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
             tool = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.tool ELSE memories.tool END,
             updated_at = MAX(excluded.updated_at, memories.updated_at)`
        );
        for (const m of data.memories ?? []) {
          memStmt.run(m.id, m.project, m.key, m.value, m.category, m.tool, m.expires_at, m.last_accessed_at, m.created_at, m.updated_at);
          counts.memories++;
        }

        // Sessions: insert or ignore
        const sesStmt = db.prepare(
          `INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const s of data.sessions ?? []) {
          sesStmt.run(s.id, s.project, s.tool, s.summary, typeof s.files === "string" ? s.files : JSON.stringify(s.files ?? []), s.started_at, s.ended_at, s.created_at);
          counts.sessions++;
        }

        // Decisions: insert or ignore
        const decStmt = db.prepare(
          `INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const d of data.decisions ?? []) {
          decStmt.run(d.id, d.project, d.topic, d.choice, d.reason, d.tool, d.created_at);
          counts.decisions++;
        }

        // Tasks: insert or ignore
        const taskStmt = db.prepare(
          `INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tool, created_at, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const t of data.tasks ?? []) {
          taskStmt.run(t.id, t.project, t.text, t.status, t.priority, t.tool, t.created_at, t.done_at);
          counts.tasks++;
        }

        return counts;
      });

      const counts = importTx();

      return ok({
        imported: true,
        project,
        strategy: strat,
        counts,
      });
    } catch (e: unknown) {
      return err(errOf(e));
    }
  }
);

// ── Start MCP Server ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
