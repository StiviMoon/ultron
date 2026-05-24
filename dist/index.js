#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/db.ts
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
var ULTRON_DIR = join(homedir(), ".ultron");
var DB_PATH = process.env.ULTRON_DB_PATH ?? join(ULTRON_DIR, "ultron.db");
var SCHEMA_SQL = `
-- memories: persistent key-value knowledge per project
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  project          TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'fact'
                   CHECK (category IN ('fact','pattern','preference','warning','note','rule')),
  tool             TEXT,
  expires_at       TEXT,
  last_accessed_at TEXT,
  access_count     INTEGER NOT NULL DEFAULT 0,
  importance       INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  related          TEXT DEFAULT '[]',
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  UNIQUE (project, key)
);

-- sessions: work session history per tool
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  summary     TEXT,
  files       TEXT DEFAULT '[]',
  started_at  TEXT DEFAULT (datetime('now')),
  ended_at    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- decisions: immutable technical decision log
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  choice      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- tasks: persistent project backlog
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','done')),
  priority    TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('high','medium','low')),
  tags        TEXT DEFAULT '[]',
  tool        TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  done_at     TEXT
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories  (project);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories  (project, category);
CREATE INDEX IF NOT EXISTS idx_memories_expires  ON memories  (project, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_score    ON memories  (project, access_count DESC, importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project  ON sessions  (project, tool);
CREATE INDEX IF NOT EXISTS idx_sessions_ended    ON sessions  (project, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions (project);
CREATE INDEX IF NOT EXISTS idx_tasks_project     ON tasks     (project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks     (project, priority)
  WHERE status = 'pending';

-- FTS5 full-text search on memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  key, value,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value)
    VALUES ('delete', old.rowid, old.key, old.value);
  INSERT INTO memories_fts(rowid, key, value)
    VALUES (new.rowid, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value)
    VALUES ('delete', old.rowid, old.key, old.value);
END;

-- Schema versioning
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '6');
`;
function initDb() {
  mkdirSync(ULTRON_DIR, { recursive: true });
  const db2 = new Database(DB_PATH);
  db2.pragma("journal_mode = WAL");
  db2.pragma("busy_timeout = 5000");
  db2.pragma("foreign_keys = ON");
  db2.exec(SCHEMA_SQL);
  try {
    db2.exec("ALTER TABLE memories ADD COLUMN related TEXT DEFAULT '[]'");
  } catch {
  }
  try {
    db2.exec("ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'");
  } catch {
  }
  try {
    db2.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
  } catch {
  }
  try {
    db2.exec("ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5");
  } catch {
  }
  try {
    const cats = db2.prepare("SELECT DISTINCT category FROM memories WHERE category NOT IN ('fact','pattern','preference','warning','note','rule')").all();
    if (cats.length === 0) {
      db2.exec(`
        CREATE TABLE IF NOT EXISTS memories_v7 (
          id TEXT PRIMARY KEY, project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'fact'
            CHECK (category IN ('fact','pattern','preference','warning','note','rule')),
          tool TEXT, expires_at TEXT, last_accessed_at TEXT,
          access_count INTEGER NOT NULL DEFAULT 0, importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
          related TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE (project, key)
        );
      `);
      const existing = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_v7'").get();
      if (existing) {
        db2.exec("INSERT OR IGNORE INTO memories_v7 SELECT id,project,key,value,category,tool,expires_at,last_accessed_at,COALESCE(access_count,0),COALESCE(importance,5),related,created_at,updated_at FROM memories");
        db2.exec("DROP TABLE memories");
        db2.exec("ALTER TABLE memories_v7 RENAME TO memories");
        db2.exec("CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)");
        db2.exec("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project,category)");
        db2.exec("CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(project,access_count DESC,importance DESC,updated_at DESC)");
      }
    }
  } catch {
  }
  db2.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '7')").run();
  return db2;
}
var db = initDb();
var uuid = randomUUID;

// src/helpers.ts
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function text(content) {
  return { content: [{ type: "text", text: content }] };
}
function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}
function errOf(e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[ULTRON]", msg);
  return msg;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}
function estimateTokens(text2) {
  return Math.ceil((text2?.length ?? 0) / 4);
}

// src/index.ts
function purgeExpired(project) {
  const result = db.prepare(
    `DELETE FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).run(project);
  return result.changes;
}
function fetchProjectContext(project, options = {}) {
  const { slim = false, maxValueLength = 1500, fields, since } = options;
  const loadAll = !fields || fields.length === 0;
  const load = (f) => loadAll || (fields?.includes(f) ?? false);
  const nowMs = Date.now();
  const sessions = load("sessions") ? db.prepare(
    "SELECT * FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5"
  ).all(project) : null;
  const rules = db.prepare(
    `SELECT id, key, value, importance FROM memories
     WHERE project = ? AND category = 'rule'
     ORDER BY importance DESC, updated_at DESC`
  ).all(project);
  const memories = load("memories") ? db.prepare(
    `SELECT *,
          (access_count * 0.4 + importance * 0.3 +
           MAX(0, 1.0 - CAST((julianday('now') - julianday(updated_at)) AS REAL) / 90.0) * 0.3) AS relevance_score
         FROM memories
         WHERE project = ? AND category != 'rule'
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY
           CASE category WHEN 'warning' THEN 20 WHEN 'pattern' THEN 10 WHEN 'preference' THEN 5 ELSE 0 END DESC,
           relevance_score DESC
         LIMIT 20`
  ).all(project) : null;
  const tasks = load("tasks") ? db.prepare(
    `SELECT * FROM tasks WHERE project = ? AND status = 'pending'
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
                  created_at ASC`
  ).all(project) : null;
  const decisions = load("decisions") ? db.prepare(
    "SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10"
  ).all(project) : null;
  const allAccessed = [...memories ?? [], ...rules];
  if (allAccessed.length > 0) {
    const ids = allAccessed.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1
       WHERE id IN (${placeholders})`
    ).run(...ids);
  }
  const lastSession = sessions?.[0] ?? null;
  const isDiff = !!since;
  const filteredMemories = isDiff && memories ? memories.filter((m) => m.updated_at > since) : memories;
  const filteredTasks = isDiff && tasks ? tasks.filter((t) => t.created_at > since) : tasks;
  const filteredDecisions = isDiff && decisions ? decisions.filter((d) => d.created_at > since) : decisions;
  const processMemory = (m) => {
    if (slim) {
      return { key: m.key, category: m.category, importance: m.importance ?? 5 };
    }
    const relatedKeys = (() => {
      try {
        return JSON.parse(m.related || "[]");
      } catch {
        return [];
      }
    })();
    return {
      key: m.key,
      value: truncate(m.value ?? "", maxValueLength),
      category: m.category,
      importance: m.importance ?? 5,
      ...m.expires_at && { expires_at: m.expires_at },
      ...m.value?.length > maxValueLength && { truncated: true },
      ...relatedKeys.length > 0 && { related: relatedKeys }
    };
  };
  const processedRules = rules.map((m) => ({
    key: m.key,
    value: m.value,
    importance: m.importance ?? 5
  }));
  const processedMemories = filteredMemories ? filteredMemories.map(processMemory) : null;
  return {
    project,
    retrieved_at: now(),
    ...isDiff && { diff_mode: true, since },
    ...slim && { note: "slim mode \u2014 memories without values. Use full recall if you need values." },
    ...rules.length > 0 && { rules: processedRules },
    last_session: lastSession ? {
      tool: lastSession.tool,
      summary: truncate(lastSession.summary ?? "", 400),
      files: JSON.parse(lastSession.files || "[]"),
      ended_at: lastSession.ended_at
    } : null,
    recent_sessions: sessions ? sessions.slice(1, 5).map((s) => ({
      tool: s.tool,
      summary: truncate(s.summary ?? "", 200),
      ended_at: s.ended_at
    })) : void 0,
    memories: processedMemories ?? void 0,
    pending_tasks: filteredTasks ? filteredTasks.map((t, i) => ({
      position: i + 1,
      id: t.id,
      text: t.text,
      priority: t.priority ?? "medium",
      ...(() => {
        try {
          return JSON.parse(t.tags || "[]");
        } catch {
          return [];
        }
      })().length > 0 && {
        tags: (() => {
          try {
            return JSON.parse(t.tags || "[]");
          } catch {
            return [];
          }
        })()
      }
    })) : void 0,
    recent_decisions: filteredDecisions ? filteredDecisions.map((d) => ({
      topic: d.topic,
      choice: d.choice,
      reason: truncate(d.reason ?? "", 300)
    })) : void 0
  };
}
var server = new McpServer({
  name: "ultron-hub",
  version: "7.0.0"
});
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
    project: z.string().describe("Project name. Ex: 'vendly', 'lukapp', 'mj'"),
    slim: z.boolean().optional().describe("If true, memories return only key+category. Saves tokens."),
    maxValueLength: z.number().optional().describe("Truncate memory values to this many characters (default: 1500)"),
    fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional().describe("Only load these sections. Omit to load everything.")
  },
  ({ project, slim, maxValueLength, fields }) => {
    try {
      return ok(fetchProjectContext(project, { slim, maxValueLength, fields }));
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "remember",
  `Save or update persistent key-value knowledge for a project.
If the key already exists, it upserts (updates the value).
Categories:
  - rule        \u2014 ALWAYS injected first in session_start, regardless of slim mode. Use for non-negotiable project rules.
  - fact        \u2014 concrete data: stack, URLs, versions
  - pattern     \u2014 code or architecture patterns to follow
  - preference  \u2014 team or developer preferences
  - warning     \u2014 things to avoid, known bugs, gotchas (loaded with high priority)
  - note        \u2014 free-form observations

importance (1-10, default 5): controls relevance ranking. Use 8-10 for critical knowledge, 1-3 for ephemeral notes.`,
  {
    project: z.string().describe("Project name"),
    key: z.string().describe("Unique identifier. Ex: 'stack-frontend', 'api-base-url'"),
    value: z.string().describe("The knowledge to save"),
    category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).default("fact").describe("Type of knowledge. 'rule' = always injected first, non-negotiable."),
    importance: z.number().min(1).max(10).optional().describe("Relevance score 1-10 (default: 5). 8-10 for critical, 1-3 for ephemeral."),
    expires_at: z.string().optional().describe("Optional ISO expiration date. Ex: '2026-06-01'. Auto-purged on session_start."),
    related: z.array(z.string()).optional().describe("Keys of related memories. Ex: ['api-pattern', 'auth-flow']. Creates a knowledge graph."),
    tool: z.string().optional().describe("Tool saving this. Ex: 'claude-code', 'cursor'")
  },
  ({ project, key, value, category, importance, expires_at, related, tool }) => {
    try {
      if (value.length > 1e4) {
        return err("Value exceeds 10,000 character limit. Save only essential information.");
      }
      const firstSegment = key.split("-")[0];
      const similar = db.prepare(
        "SELECT key, category FROM memories WHERE project = ? AND key != ? AND key LIKE ?"
      ).all(project, key, `${firstSegment}-%`);
      const warnings = [];
      if (similar.length > 0) {
        warnings.push(
          `Similar keys exist in '${project}': ${similar.map((m) => `'${m.key}'`).join(", ")}. Consider updating one of those instead of creating a new memory.`
        );
      }
      if (value.length > 600) {
        warnings.push(
          `Long value (${value.length} chars, recommended <600). If this is a full plan or spec, save it as a .md file and reference the path here.`
        );
      }
      const autoImportance = importance ?? (category === "rule" ? 9 : category === "warning" ? 8 : category === "pattern" ? 7 : category === "preference" ? 6 : 5);
      const id = uuid();
      const relatedJson = JSON.stringify(related ?? []);
      db.prepare(
        `INSERT INTO memories (id, project, key, value, category, importance, tool, updated_at, expires_at, related)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, key) DO UPDATE SET
           value = excluded.value,
           category = excluded.category,
           importance = excluded.importance,
           tool = excluded.tool,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at,
           related = excluded.related`
      ).run(id, project, key, value, category, autoImportance, tool ?? "claude-code", now(), expires_at ?? null, relatedJson);
      return ok({
        saved: true,
        project,
        key,
        category,
        importance: autoImportance,
        value,
        ...expires_at && { expires_at },
        ...related && related.length > 0 && { related },
        ...warnings.length > 0 && { warnings }
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "note",
  `Save a quick thought without needing to define an explicit key.
Shortcut for remember with category=note and auto-generated key.
Useful for quick observations, ideas, or notes during work.`,
  {
    project: z.string().describe("Project name"),
    text: z.string().describe("The thought or note to save"),
    tool: z.string().optional()
  },
  ({ project, text: noteText, tool }) => {
    try {
      const slug = noteText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/-+$/, "");
      const key = `note-${slug || Date.now()}`;
      const id = uuid();
      db.prepare(
        "INSERT INTO memories (id, project, key, value, category, tool) VALUES (?, ?, ?, ?, 'note', ?)"
      ).run(id, project, key, noteText, tool ?? "claude-code");
      return ok({ saved: true, project, key });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "forget",
  `Delete a specific memory from a project by its key.
Use to clean up outdated or incorrect knowledge.
Use recall or search first to see available keys.`,
  {
    project: z.string().describe("Project name"),
    key: z.string().describe("Exact key of the memory to delete")
  },
  ({ project, key }) => {
    try {
      const result = db.prepare(
        "DELETE FROM memories WHERE project = ? AND key = ?"
      ).run(project, key);
      if (result.changes === 0) return err(`No memory found with key '${key}' in project '${project}'`);
      return ok({ deleted: true, project, key });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "search",
  `Search by text across memories, decisions, and/or tasks.
Uses full-text search (FTS5) for memories \u2014 fast and ranked by relevance.

scope controls where to search (default: memories only):
  - "memories"  \u2014 searches key and value (FTS5)
  - "decisions" \u2014 searches topic, choice, and reason
  - "tasks"     \u2014 searches task text`,
  {
    project: z.string().describe("Base project name"),
    query: z.string().describe("Text to search for"),
    scope: z.array(z.enum(["memories", "decisions", "tasks"])).optional().describe("Where to search (default: ['memories'])"),
    projects: z.array(z.string()).optional().describe("Projects to search. Default: base project only. Use ['all'] for all projects.")
  },
  ({ project, query, scope, projects }) => {
    try {
      const searchIn = scope && scope.length > 0 ? scope : ["memories"];
      let targetProjects;
      if (projects && projects.includes("all")) {
        const allProjs = db.prepare("SELECT DISTINCT project FROM memories").all();
        const allSet = /* @__PURE__ */ new Set([project, ...allProjs.map((r) => r.project)]);
        targetProjects = Array.from(allSet);
      } else if (projects && projects.length > 0) {
        targetProjects = [.../* @__PURE__ */ new Set([project, ...projects])];
      } else {
        targetProjects = [project];
      }
      const multiProject = targetProjects.length > 1;
      const results = {};
      const placeholders = targetProjects.map(() => "?").join(",");
      if (searchIn.includes("memories")) {
        let rows;
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
          rows = db.prepare(
            `SELECT id, project, key, value, category, updated_at
             FROM memories
             WHERE project IN (${placeholders})
             AND (key LIKE ? OR value LIKE ?)
             ORDER BY updated_at DESC
             LIMIT 20`
          ).all(...targetProjects, `%${query}%`, `%${query}%`);
        }
        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          const idPlaceholders = ids.map(() => "?").join(",");
          db.prepare(
            `UPDATE memories SET last_accessed_at = datetime('now') WHERE id IN (${idPlaceholders})`
          ).run(...ids);
        }
        results.memories = rows.map((m) => ({
          ...multiProject && { project: m.project },
          key: m.key,
          value: truncate(m.value ?? "", 600),
          category: m.category
        }));
      }
      if (searchIn.includes("decisions")) {
        const rows = db.prepare(
          `SELECT project, topic, choice, reason, created_at
           FROM decisions
           WHERE project IN (${placeholders})
           AND (topic LIKE ? OR choice LIKE ? OR reason LIKE ?)
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(...targetProjects, `%${query}%`, `%${query}%`, `%${query}%`);
        results.decisions = rows.map((d) => ({
          ...multiProject && { project: d.project },
          topic: d.topic,
          choice: d.choice,
          reason: d.reason
        }));
      }
      if (searchIn.includes("tasks")) {
        const rows = db.prepare(
          `SELECT project, id, text, status, priority, created_at
           FROM tasks
           WHERE project IN (${placeholders})
           AND text LIKE ?
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(...targetProjects, `%${query}%`);
        results.tasks = rows.map((t) => ({
          ...multiProject && { project: t.project },
          id: t.id,
          text: t.text,
          status: t.status,
          priority: t.priority
        }));
      }
      const totalFound = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
      return ok({
        project,
        searched_projects: targetProjects,
        query,
        scope: searchIn,
        total_found: totalFound,
        results
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "task",
  `Manage the persistent project backlog.
Actions:
  - add    \u2014 add a new task (requires: text, optional: priority)
  - update \u2014 edit text and/or priority of an existing task (requires: id, optional: newText, newPriority)
  - done   \u2014 mark a task as completed (requires: id as UUID or position 1, 2, 3...)
  - delete \u2014 permanently delete a task (requires: id as UUID or position)
  - list   \u2014 list all tasks (pending and completed)
Positions (1, 2, 3...) come from recall or task list results.`,
  {
    project: z.string().describe("Project name"),
    action: z.enum(["add", "update", "done", "list", "delete"]).describe("Operation to perform"),
    text: z.string().optional().describe("Task text \u2014 only for action=add"),
    id: z.string().optional().describe("UUID or position (1, 2, 3...) \u2014 for action=done, update, or delete"),
    priority: z.enum(["high", "medium", "low"]).optional().default("medium").describe("Task priority \u2014 for action=add"),
    newText: z.string().optional().describe("New task text \u2014 only for action=update"),
    newPriority: z.enum(["high", "medium", "low"]).optional().describe("New priority \u2014 only for action=update"),
    tags: z.array(z.string()).optional().describe("Tags for the task \u2014 for action=add. Ex: ['auth', 'urgent']"),
    newTags: z.array(z.string()).optional().describe("Replace tags \u2014 only for action=update"),
    filter_tag: z.string().optional().describe("Filter by tag \u2014 only for action=list"),
    tool: z.string().optional()
  },
  ({ project, action, text: taskText, id, priority, newText, newPriority, tags, newTags, filter_tag, tool }) => {
    try {
      let resolveId2 = function(rawId) {
        const pos = parseInt(rawId);
        if (!isNaN(pos) && String(pos) === rawId) {
          const pending = db.prepare(
            "SELECT id FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC"
          ).all(project);
          return pending[pos - 1]?.id ?? null;
        }
        return rawId;
      };
      var resolveId = resolveId2;
      if (action === "add") {
        if (!taskText) return err("'text' is required for action=add");
        const id2 = uuid();
        const tagsJson = JSON.stringify(tags ?? []);
        db.prepare(
          "INSERT INTO tasks (id, project, text, priority, tags, tool) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id2, project, taskText, priority ?? "medium", tagsJson, tool ?? "claude-code");
        return ok({ added: true, id: id2, text: taskText, priority: priority ?? "medium", ...tags?.length && { tags } });
      }
      if (action === "update") {
        if (!id) return err("'id' is required for action=update");
        if (!newText && !newPriority && !newTags) return err("'newText', 'newPriority', or 'newTags' required for action=update");
        const targetId = resolveId2(id);
        if (!targetId) return err(`No task at position ${id} or ID not found.`);
        const sets = [];
        const vals = [];
        if (newText) {
          sets.push("text = ?");
          vals.push(newText);
        }
        if (newPriority) {
          sets.push("priority = ?");
          vals.push(newPriority);
        }
        if (newTags) {
          sets.push("tags = ?");
          vals.push(JSON.stringify(newTags));
        }
        vals.push(targetId, project);
        db.prepare(
          `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project = ?`
        ).run(...vals);
        return ok({ updated: true, id: targetId, ...newText && { text: newText }, ...newPriority && { priority: newPriority }, ...newTags && { tags: newTags } });
      }
      if (action === "done" || action === "delete") {
        if (!id) return err(`'id' is required for action=${action}`);
        const targetId = resolveId2(id);
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
      if (action === "list") {
        const rows = db.prepare(
          "SELECT id, text, status, priority, tags, created_at, done_at FROM tasks WHERE project = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END, created_at ASC"
        ).all(project);
        const parseTags = (t) => {
          try {
            return JSON.parse(t.tags || "[]");
          } catch {
            return [];
          }
        };
        let pending = rows.filter((t) => t.status === "pending");
        if (filter_tag) {
          pending = pending.filter((t) => parseTags(t).includes(filter_tag));
        }
        const pendingMapped = pending.map((t, i) => ({
          position: i + 1,
          id: t.id,
          text: t.text,
          priority: t.priority,
          ...parseTags(t).length > 0 && { tags: parseTags(t) }
        }));
        const done = rows.filter((t) => t.status === "done").map((t) => ({ id: t.id, text: t.text, done_at: t.done_at }));
        return ok({ project, ...filter_tag && { filter_tag }, pending: pendingMapped, done });
      }
      return err("Invalid action");
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "decision",
  `Log a technical or design decision in an immutable record \u2014 never deleted.
Use when choosing a technology, pattern, or approach over alternatives.
The decision history helps any model understand why the code is the way it is.`,
  {
    project: z.string().describe("Project name"),
    topic: z.string().describe("Decision topic. Ex: 'database', 'auth', 'ui-framework', 'deploy'"),
    choice: z.string().describe("What you chose. Ex: 'Supabase', 'JWT', 'Tailwind CSS', 'Render'"),
    reason: z.string().describe("Why you chose it. Be specific \u2014 include discarded alternatives if applicable."),
    tool: z.string().optional()
  },
  ({ project, topic, choice, reason, tool }) => {
    try {
      const id = uuid();
      db.prepare(
        "INSERT INTO decisions (id, project, topic, choice, reason, tool) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, project, topic, choice, reason, tool ?? "claude-code");
      return ok({ logged: true, id, project, topic, choice });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "list_decisions",
  `List the full history of technical decisions for a project with pagination.
Unlike recall (which shows only the 10 most recent), here you can see all decisions.
Decisions are immutable \u2014 never deleted. They are the definitive record of why the code is the way it is.`,
  {
    project: z.string().describe("Project name"),
    limit: z.number().optional().default(20).describe("Max decisions to return (default: 20)"),
    offset: z.number().optional().default(0).describe("Pagination offset (default: 0)")
  },
  ({ project, limit, offset }) => {
    try {
      const lim = limit ?? 20;
      const off = offset ?? 0;
      const count = db.prepare(
        "SELECT COUNT(*) as total FROM decisions WHERE project = ?"
      ).get(project)?.total ?? 0;
      const rows = db.prepare(
        "SELECT topic, choice, reason, tool, created_at FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).all(project, lim, off);
      return ok({ project, total: count, offset: off, limit: lim, decisions: rows });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "projects",
  `List all projects registered in ULTRON with statistics:
last session, pending tasks, memory count, and decision count.
Use to discover what projects exist before running recall,
or for a general overview of all project states.`,
  {},
  () => {
    try {
      const projectRows = db.prepare(
        `SELECT DISTINCT project FROM (
           SELECT project FROM memories
           UNION SELECT project FROM sessions
           UNION SELECT project FROM tasks
           UNION SELECT project FROM decisions
         )`
      ).all();
      const projectList = projectRows.map((row) => {
        const p = row.project;
        const lastSession = db.prepare(
          "SELECT tool, summary, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
        ).get(p);
        const memoriesCount = db.prepare(
          "SELECT COUNT(*) as c FROM memories WHERE project = ?"
        ).get(p)?.c ?? 0;
        const pendingCount = db.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE project = ? AND status = 'pending'"
        ).get(p)?.c ?? 0;
        const decisionsCount = db.prepare(
          "SELECT COUNT(*) as c FROM decisions WHERE project = ?"
        ).get(p)?.c ?? 0;
        return {
          project: p,
          last_session: lastSession ? { tool: lastSession.tool, summary: truncate(lastSession.summary ?? "", 150), ended_at: lastSession.ended_at } : null,
          pending_tasks: pendingCount,
          memories_count: memoriesCount,
          decisions_count: decisionsCount
        };
      });
      projectList.sort((a, b) => {
        if (!a.last_session) return 1;
        if (!b.last_session) return -1;
        return new Date(b.last_session.ended_at).getTime() - new Date(a.last_session.ended_at).getTime();
      });
      return ok({ total: projectList.length, projects: projectList });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "session_start",
  `Register the start of a work session AND automatically load the full project context.
Equivalent to session_start + recall in one step.
Call at the beginning of work \u2014 returns everything needed to resume.

v7 improvements:
  - Rules (category='rule') are ALWAYS injected first, full values, never truncated
  - Memories ranked by relevance score (access_count + importance + recency), not just date
  - Expired memories are auto-purged before loading context
  - diff_since: only return what changed since a given ISO timestamp (saves tokens for re-opens)

Token control:
  - slim: true = memories without values (keys only). ~80% token reduction.
  - fields: load only specific sections ["sessions", "memories", "tasks", "decisions"]
  - diff_since: ISO timestamp \u2014 only return changed items since then`,
  {
    project: z.string().describe("Project name"),
    tool: z.string().describe("Current tool. Ex: 'claude-code', 'cursor'"),
    slim: z.boolean().optional().describe("If true, memories return only key+category+importance (no values)."),
    fields: z.array(z.enum(["sessions", "memories", "tasks", "decisions"])).optional().describe("Only load these sections. Omit to load everything."),
    diff_since: z.string().optional().describe("ISO timestamp. Only return memories/tasks/decisions updated after this. Use for quick re-open without full reload.")
  },
  ({ project, tool, slim, fields, diff_since }) => {
    try {
      const purged = purgeExpired(project);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1e3).toISOString();
      const staleClosed = db.prepare(
        `UPDATE sessions SET ended_at = ?, summary = 'Auto-closed \u2014 stale session (>2h without session_end)'
         WHERE project = ? AND ended_at IS NULL AND started_at < ?`
      ).run(now(), project, twoHoursAgo).changes;
      const sessionId = uuid();
      db.prepare(
        "INSERT INTO sessions (id, project, tool) VALUES (?, ?, ?)"
      ).run(sessionId, project, tool);
      const context = fetchProjectContext(project, { slim, fields, since: diff_since });
      return ok({
        session_id: sessionId,
        started_at: now(),
        ...purged > 0 && { auto_purged_expired: purged },
        ...staleClosed > 0 && { auto_closed_stale_sessions: staleClosed },
        ...context
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "session_end",
  `Close the active session with a summary of what was done.
Call when finishing work \u2014 records what was done and what files were touched
so the next session can resume from here.`,
  {
    project: z.string().describe("Project name"),
    tool: z.string().describe("Current tool"),
    summary: z.string().describe("Clear summary of what was done this session. Be specific."),
    files: z.array(z.string()).optional().describe("Main files created or modified this session")
  },
  ({ project, tool, summary, files }) => {
    try {
      const openSession = db.prepare(
        "SELECT id FROM sessions WHERE project = ? AND tool = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
      ).get(project, tool);
      if (!openSession) {
        return ok({
          closed: false,
          warning: `No open session found for '${project}' (${tool}). Use session_start at the beginning of each work session.`,
          project,
          tool
        });
      }
      db.prepare(
        "UPDATE sessions SET summary = ?, files = ?, ended_at = ? WHERE id = ?"
      ).run(summary, JSON.stringify(files ?? []), now(), openSession.id);
      const pendingTasks = db.prepare(
        "SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END LIMIT 5"
      ).all(project);
      const topMemories = db.prepare(
        "SELECT key FROM memories WHERE project = ? AND key != '_snapshot' ORDER BY updated_at DESC LIMIT 8"
      ).all(project);
      const snapshotValue = [
        `Last session (${tool}): ${summary}`,
        files?.length ? `Files: ${files.slice(0, 5).join(", ")}` : null,
        pendingTasks.length ? `Pending tasks: ${pendingTasks.map((t) => `[${t.priority}] ${t.text}`).join(" | ")}` : "No pending tasks",
        topMemories.length ? `Key knowledge: ${topMemories.map((m) => m.key).join(", ")}` : null
      ].filter(Boolean).join(" \u2014 ");
      db.prepare(
        `INSERT INTO memories (id, project, key, value, category, tool, updated_at)
         VALUES (?, ?, '_snapshot', ?, 'note', ?, datetime('now'))
         ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, tool = excluded.tool, updated_at = excluded.updated_at`
      ).run(uuid(), project, snapshotValue, tool);
      return ok({ closed: true, project, tool, summary, snapshot_saved: true });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
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
      ).get(project);
      const memories = db.prepare(
        "SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 20"
      ).all(project);
      const tasks = db.prepare(
        "SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending' ORDER BY created_at ASC"
      ).all(project);
      const decisions = db.prepare(
        "SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 8"
      ).all(project);
      const date = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", {
        day: "numeric",
        month: "long",
        year: "numeric"
      });
      let md = `## [ULTRON CONTEXT \u2014 ${project} \u2014 ${date}]

`;
      md += `> Generated by ULTRON Hub v5. Paste this at the start of your conversation.

`;
      if (lastSession) {
        md += `### Last session (${lastSession.tool})
`;
        md += `${truncate(lastSession.summary ?? "No summary", 500)}
`;
        const files = JSON.parse(lastSession.files || "[]");
        if (files.length) {
          md += `**Files:** ${files.join(", ")}
`;
        }
        md += "\n";
      }
      if (memories.length) {
        const byCategory = {};
        for (const m of memories) {
          byCategory[m.category] = byCategory[m.category] ?? [];
          byCategory[m.category].push(m);
        }
        md += `### Project knowledge
`;
        for (const [cat, items] of Object.entries(byCategory)) {
          md += `
**${cat.charAt(0).toUpperCase() + cat.slice(1)}:**
`;
          for (const m of items) {
            md += `- **${m.key}**: ${truncate(m.value ?? "", 400)}
`;
          }
        }
        md += "\n";
      }
      if (decisions.length) {
        md += `### Technical decisions
`;
        for (const d of decisions) {
          md += `- **${d.topic}** \u2192 ${d.choice} \u2014 ${truncate(d.reason ?? "", 200)}
`;
        }
        md += "\n";
      }
      if (tasks.length) {
        md += `### Pending tasks
`;
        for (const t of tasks) {
          const badge = t.priority === "high" ? " [HIGH]" : t.priority === "low" ? " [LOW]" : "";
          md += `- [ ] ${t.text}${badge}
`;
        }
        md += "\n";
      }
      md += `---
_ULTRON Hub v5_`;
      return text(md);
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "clean",
  `List and optionally delete stale memories \u2014 those not accessed in 45+ days.
Actions:
  - list    \u2014 show stale memories (default). Does not delete anything.
  - archive \u2014 delete all stale memories for the project.
  - delete  \u2014 delete a specific memory by key.

Use token_budget() first to see how many stale memories exist.
Stale memories are ones with last_accessed_at older than 45 days (or never accessed).`,
  {
    project: z.string().describe("Project name"),
    action: z.enum(["list", "archive", "delete"]).optional().default("list").describe("'list' = show stale, 'archive' = delete all stale, 'delete' = delete specific key"),
    key: z.string().optional().describe("Memory key to delete \u2014 only for action=delete"),
    days: z.number().optional().default(45).describe("Stale threshold in days (default: 45)")
  },
  ({ project, action, key, days }) => {
    try {
      const threshold = days ?? 45;
      const act = action ?? "list";
      if (act === "delete") {
        if (!key) return err("'key' is required for action=delete");
        const result = db.prepare("DELETE FROM memories WHERE project = ? AND key = ?").run(project, key);
        if (result.changes === 0) return err(`No memory found with key '${key}' in project '${project}'`);
        return ok({ deleted: true, project, key });
      }
      const stale = db.prepare(
        `SELECT key, category, value, last_accessed_at, created_at FROM memories
         WHERE project = ?
         AND key != '_snapshot'
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-' || ? || ' days'))
         ORDER BY last_accessed_at ASC NULLS FIRST`
      ).all(project, threshold);
      if (act === "archive") {
        if (stale.length === 0) return ok({ archived: 0, message: `No stale memories found (threshold: ${threshold} days)` });
        const ids = stale.map((m) => m.key);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM memories WHERE project = ? AND key IN (${placeholders})`
        ).run(project, ...ids);
        return ok({ archived: stale.length, project, threshold_days: threshold, deleted_keys: ids });
      }
      return ok({
        project,
        threshold_days: threshold,
        stale_count: stale.length,
        stale_memories: stale.map((m) => ({
          key: m.key,
          category: m.category,
          last_accessed: m.last_accessed_at ?? "never",
          created_at: m.created_at,
          preview: truncate(m.value ?? "", 100)
        })),
        hint: stale.length > 0 ? `Run clean(project, action='archive') to delete all, or clean(project, action='delete', key='...') for specific ones.` : `No stale memories \u2014 project is clean.`
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "generate_rules",
  `Convert project memories (rules, warnings, patterns, preferences) into CLAUDE.md-compatible rules.
Returns markdown ready to paste into your project's CLAUDE.md file.
The rules are extracted from real experience stored in ULTRON \u2014 specific to YOUR failure modes, not generic advice.

Category 'rule' is now a first-class category \u2014 always listed first, sorted by importance.`,
  {
    project: z.string().describe("Project name"),
    categories: z.array(z.enum(["rule", "warning", "pattern", "preference", "fact"])).optional().describe("Categories to include. Default: ['rule', 'warning', 'pattern', 'preference']")
  },
  ({ project, categories }) => {
    try {
      const cats = categories && categories.length > 0 ? categories : ["rule", "warning", "pattern", "preference"];
      const placeholders = cats.map(() => "?").join(",");
      const memories = db.prepare(
        `SELECT key, value, category, importance FROM memories
         WHERE project = ? AND category IN (${placeholders})
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY CASE category WHEN 'rule' THEN 0 WHEN 'warning' THEN 1 WHEN 'pattern' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END,
                  importance DESC, key`
      ).all(project, ...cats);
      if (memories.length === 0) {
        return text(`No memories found in categories [${cats.join(", ")}] for project '${project}'.
Use remember() to store warnings and patterns as you work.`);
      }
      const grouped = {};
      for (const m of memories) {
        grouped[m.category] = grouped[m.category] ?? [];
        grouped[m.category].push(m);
      }
      let md = `# Project Rules: ${project}
`;
      md += `# Generated by ULTRON Hub v7 \u2014 paste into your project's CLAUDE.md

`;
      if (grouped.rule) {
        md += `## Non-negotiable Rules
`;
        md += `<!-- Always active \u2014 injected first in every session -->

`;
        for (const m of grouped.rule) {
          md += `- ${m.value}
`;
        }
        md += "\n";
      }
      if (grouped.warning) {
        md += `## Avoid
`;
        md += `<!-- Things to watch out for \u2014 learned from real experience -->

`;
        for (const m of grouped.warning) {
          md += `- ${m.value}
`;
        }
        md += "\n";
      }
      if (grouped.pattern) {
        md += `## Follow
`;
        md += `<!-- Architecture and code patterns that work in this project -->

`;
        for (const m of grouped.pattern) {
          md += `- ${m.value}
`;
        }
        md += "\n";
      }
      if (grouped.preference) {
        md += `## Preferences
`;
        md += `<!-- Team conventions and style rules -->

`;
        for (const m of grouped.preference) {
          md += `- ${m.value}
`;
        }
        md += "\n";
      }
      if (grouped.fact) {
        md += `## Facts
`;
        md += `<!-- Key project data -->

`;
        for (const m of grouped.fact) {
          md += `- **${m.key}**: ${m.value}
`;
        }
        md += "\n";
      }
      md += `---
`;
      md += `_Generated by ULTRON Hub v7 on ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}_
`;
      return text(md);
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "token_budget",
  `Estimate how many tokens a full recall() for this project would consume.
Broken down by section (memories, sessions, tasks, decisions).
Suggests optimizations if token usage is high.`,
  {
    project: z.string().describe("Project name")
  },
  ({ project }) => {
    try {
      const memories = db.prepare(
        "SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30"
      ).all(project);
      const sessions = db.prepare(
        "SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5"
      ).all(project);
      const tasks = db.prepare(
        "SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'"
      ).all(project);
      const decisions = db.prepare(
        "SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10"
      ).all(project);
      const staleCount = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ?
         AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-45 days'))`
      ).get(project)?.c ?? 0;
      const sections = {
        memories: { count: memories.length, tokens: estimateTokens(JSON.stringify(memories)) },
        sessions: { count: sessions.length, tokens: estimateTokens(JSON.stringify(sessions)) },
        tasks: { count: tasks.length, tokens: estimateTokens(JSON.stringify(tasks)) },
        decisions: { count: decisions.length, tokens: estimateTokens(JSON.stringify(decisions)) }
      };
      const total = Object.values(sections).reduce((sum, s) => sum + s.tokens, 0);
      const suggestions = [];
      if (total > 5e3 && memories.length > 15) {
        suggestions.push("Use session_start with slim:true to reduce memory tokens by ~80%");
      }
      if (tasks.length > 20) {
        suggestions.push("Mark completed tasks as done \u2014 task list is large");
      }
      if (staleCount > 5) {
        suggestions.push(`${staleCount} memories not accessed in 45+ days \u2014 run clean(project, action='archive') to purge`);
      }
      if (total > 8e3) {
        suggestions.push("Use fields:['memories','tasks'] to skip sessions/decisions in recall");
        suggestions.push("Run health(project) for a full integrity report and compression opportunities");
      }
      const rulesCount = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND category = 'rule'`
      ).get(project)?.c ?? 0;
      if (rulesCount === 0 && memories.length > 10) {
        suggestions.push("No 'rule' memories defined \u2014 consider promoting key warnings/patterns to category='rule' for guaranteed injection");
      }
      return ok({
        project,
        total_estimated_tokens: total,
        sections,
        stale_memories: staleCount,
        ...suggestions.length > 0 && { suggestions },
        ...total > 8e3 && { warning: `High token usage (${total} estimated). Consider optimizations above.` }
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "health",
  `Project integrity diagnostics \u2014 proactive analysis of memory quality and token efficiency.
Returns actionable warnings, not just stats.

Checks:
  - Expired memories still in DB
  - Memories never accessed (created >30d ago, access_count=0)
  - Snapshot age (outdated if last session was >7d ago and snapshot not refreshed)
  - Duplicate/overlapping memories (same key prefix, high count)
  - Total token estimate vs recommended limit
  - Tasks completed but not marked done (heuristic: done keywords in text)
  - Memories with low importance that are very old

Use this at the start of a session to decide whether to clean before loading full context.`,
  {
    project: z.string().describe("Project name")
  },
  ({ project }) => {
    try {
      const issues = [];
      const expiredCount = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
      ).get(project)?.c ?? 0;
      if (expiredCount > 0) {
        issues.push({ severity: "error", message: `${expiredCount} expired memories still in DB`, action: "session_start() auto-purges them, or run forget() manually" });
      }
      const neverAccessed = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND access_count = 0 AND created_at < datetime('now', '-30 days') AND category != 'rule'`
      ).get(project)?.c ?? 0;
      if (neverAccessed > 3) {
        issues.push({ severity: "warning", message: `${neverAccessed} memories never accessed in 30+ days`, action: "clean(project, action='list') to review, then forget() stale ones" });
      }
      const snapshot = db.prepare(
        `SELECT updated_at FROM memories WHERE project = ? AND key = '_snapshot'`
      ).get(project);
      const lastSession = db.prepare(
        `SELECT ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`
      ).get(project);
      if (lastSession && !snapshot) {
        issues.push({ severity: "warning", message: "No snapshot exists \u2014 session_end() was never called", action: "Always call session_end() when finishing work" });
      } else if (snapshot && lastSession) {
        const snapshotAgeDays = (Date.now() - new Date(snapshot.updated_at).getTime()) / (1e3 * 60 * 60 * 24);
        if (snapshotAgeDays > 7) {
          issues.push({ severity: "info", message: `Snapshot is ${Math.round(snapshotAgeDays)}d old`, action: "Call session_end() to refresh snapshot" });
        }
      }
      const totalMemories = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
      ).get(project)?.c ?? 0;
      const allValues = db.prepare(
        `SELECT value FROM memories WHERE project = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
      ).all(project);
      const totalChars = allValues.reduce((sum, m) => sum + (m.value?.length ?? 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 4);
      if (estimatedTokens > 8e3) {
        issues.push({ severity: "warning", message: `High token footprint: ~${estimatedTokens} tokens across ${totalMemories} memories`, action: "Use slim:true in session_start, or clean stale memories" });
      }
      const prefixCounts = db.prepare(
        `SELECT SUBSTR(key, 1, INSTR(key || '-', '-') - 1) as prefix, COUNT(*) as c
         FROM memories WHERE project = ? AND key != '_snapshot'
         GROUP BY prefix HAVING c >= 4`
      ).all(project);
      for (const row of prefixCounts) {
        issues.push({ severity: "info", message: `Key prefix '${row.prefix}-' has ${row.c} memories \u2014 possible overlap`, action: `compress(project, prefix='${row.prefix}') to collapse into one structured memory` });
      }
      const lowOldCount = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND importance <= 3 AND updated_at < datetime('now', '-60 days')`
      ).get(project)?.c ?? 0;
      if (lowOldCount > 0) {
        issues.push({ severity: "info", message: `${lowOldCount} low-importance memories older than 60d`, action: "Consider forget() or clean() to reduce noise" });
      }
      const rulesCount = db.prepare(
        `SELECT COUNT(*) as c FROM memories WHERE project = ? AND category = 'rule'`
      ).get(project)?.c ?? 0;
      const pendingCount = db.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE project = ? AND status = 'pending'`
      ).get(project)?.c ?? 0;
      const score = Math.max(0, 100 - issues.filter((i) => i.severity === "error").length * 20 - issues.filter((i) => i.severity === "warning").length * 10 - issues.filter((i) => i.severity === "info").length * 5);
      return ok({
        project,
        health_score: score,
        status: score >= 80 ? "healthy" : score >= 50 ? "needs_attention" : "degraded",
        stats: {
          total_memories: totalMemories,
          rules: rulesCount,
          pending_tasks: pendingCount,
          estimated_tokens: estimatedTokens,
          expired_memories: expiredCount
        },
        issues,
        ...issues.length === 0 && { message: "Project memory is clean and optimized." }
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "compress",
  `Collapse multiple related memories into a single structured memory.
Reduces token bloat when a topic has accumulated many small memories.

Use when:
  - Several memories share the same key prefix (health() will flag this)
  - A topic has 3+ related memories that could be one structured note
  - You want to reduce context size before a heavy session

How it works:
  1. Reads all memories matching the given keys (or prefix)
  2. You provide the compressed value (structured summary of all of them)
  3. ULTRON deletes the originals and saves the new compressed memory
  4. The new memory gets importance = max(importance of originals)`,
  {
    project: z.string().describe("Project name"),
    keys: z.array(z.string()).describe("Keys of memories to collapse into one"),
    new_key: z.string().describe("Key for the resulting compressed memory"),
    new_value: z.string().describe("Compressed content \u2014 structured summary of all source memories"),
    new_category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional().default("fact").describe("Category for the compressed memory"),
    preview_only: z.boolean().optional().describe("If true, returns source memories without deleting \u2014 for review before compressing")
  },
  ({ project, keys, new_key, new_value, new_category, preview_only }) => {
    try {
      if (keys.length < 2) return err("compress requires at least 2 keys to collapse");
      const placeholders = keys.map(() => "?").join(",");
      const sources = db.prepare(
        `SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${placeholders})`
      ).all(project, ...keys);
      if (sources.length === 0) return err(`No memories found for keys: ${keys.join(", ")}`);
      if (preview_only) {
        return ok({
          preview: true,
          project,
          source_memories: sources.map((m) => ({ key: m.key, category: m.category, importance: m.importance, value: m.value })),
          hint: "Review above, then call compress() without preview_only:true to execute."
        });
      }
      const maxImportance = Math.max(...sources.map((m) => m.importance ?? 5));
      const allRelated = Array.from(new Set(
        sources.flatMap((m) => {
          try {
            return JSON.parse(m.related || "[]");
          } catch {
            return [];
          }
        }).filter((k) => !keys.includes(k))
      ));
      db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${placeholders})`).run(project, ...keys);
      const id = uuid();
      db.prepare(
        `INSERT INTO memories (id, project, key, value, category, importance, related, tool, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code', datetime('now'))
         ON CONFLICT (project, key) DO UPDATE SET
           value = excluded.value, category = excluded.category,
           importance = excluded.importance, related = excluded.related, updated_at = excluded.updated_at`
      ).run(id, project, new_key, new_value, new_category ?? "fact", maxImportance, JSON.stringify(allRelated));
      return ok({
        compressed: true,
        project,
        deleted_keys: sources.map((m) => m.key),
        new_memory: { key: new_key, category: new_category ?? "fact", importance: maxImportance },
        tokens_saved_estimate: Math.ceil(sources.reduce((sum, m) => sum + (m.value?.length ?? 0), 0) / 4)
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "export_project",
  `Export all data for a project as a JSON blob.
Use for backups or to sync data between machines.
Import with import_project on another machine.`,
  {
    project: z.string().describe("Project name to export")
  },
  ({ project }) => {
    try {
      const memories = db.prepare("SELECT * FROM memories WHERE project = ?").all(project);
      const sessions = db.prepare("SELECT * FROM sessions WHERE project = ?").all(project);
      const decisions = db.prepare("SELECT * FROM decisions WHERE project = ?").all(project);
      const tasks = db.prepare("SELECT * FROM tasks WHERE project = ?").all(project);
      return ok({
        ultron_version: "5.0.0",
        exported_at: now(),
        project,
        counts: {
          memories: memories.length,
          sessions: sessions.length,
          decisions: decisions.length,
          tasks: tasks.length
        },
        data: { memories, sessions, decisions, tasks }
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
server.tool(
  "import_project",
  `Import a previously exported JSON blob, merging into the local database.
Strategies:
  - merge   \u2014 upsert memories (keep newer by updated_at), INSERT OR IGNORE for sessions/decisions/tasks
  - replace \u2014 delete ALL project data first, then insert everything fresh`,
  {
    data: z.string().describe("JSON string from a previous export_project() call"),
    strategy: z.enum(["merge", "replace"]).optional().default("merge").describe("'merge' = upsert keeping newer data, 'replace' = delete all then insert")
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
        const counts2 = { memories: 0, sessions: 0, decisions: 0, tasks: 0 };
        if (strat === "replace") {
          db.prepare("DELETE FROM memories WHERE project = ?").run(project);
          db.prepare("DELETE FROM sessions WHERE project = ?").run(project);
          db.prepare("DELETE FROM decisions WHERE project = ?").run(project);
          db.prepare("DELETE FROM tasks WHERE project = ?").run(project);
        }
        const memStmt = db.prepare(
          `INSERT INTO memories (id, project, key, value, category, importance, tool, expires_at, last_accessed_at, access_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project, key) DO UPDATE SET
             value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
             category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
             importance = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.importance ELSE memories.importance END,
             tool = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.tool ELSE memories.tool END,
             updated_at = MAX(excluded.updated_at, memories.updated_at),
             access_count = MAX(excluded.access_count, memories.access_count)`
        );
        for (const m of data.memories ?? []) {
          memStmt.run(m.id, m.project, m.key, m.value, m.category, m.importance ?? 5, m.tool, m.expires_at, m.last_accessed_at, m.access_count ?? 0, m.created_at, m.updated_at);
          counts2.memories++;
        }
        const sesStmt = db.prepare(
          `INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const s of data.sessions ?? []) {
          sesStmt.run(s.id, s.project, s.tool, s.summary, typeof s.files === "string" ? s.files : JSON.stringify(s.files ?? []), s.started_at, s.ended_at, s.created_at);
          counts2.sessions++;
        }
        const decStmt = db.prepare(
          `INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const d of data.decisions ?? []) {
          decStmt.run(d.id, d.project, d.topic, d.choice, d.reason, d.tool, d.created_at);
          counts2.decisions++;
        }
        const taskStmt = db.prepare(
          `INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tool, created_at, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const t of data.tasks ?? []) {
          taskStmt.run(t.id, t.project, t.text, t.status, t.priority, t.tool, t.created_at, t.done_at);
          counts2.tasks++;
        }
        return counts2;
      });
      const counts = importTx();
      return ok({
        imported: true,
        project,
        strategy: strat,
        counts
      });
    } catch (e) {
      return err(errOf(e));
    }
  }
);
var transport = new StdioServerTransport();
await server.connect(transport);
