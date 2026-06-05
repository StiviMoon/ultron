// ── ULTRON v8 — maintenance tools ─────────────────────────────────────────────
// clean · health · metrics · compress · graph · generate_rules · token_budget
// · export_project · import_project

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, uuid } from "../db/connection.js";
import { ok, err, errOf, text, now, truncate } from "../lib/result.js";
import { estimateTokens } from "../lib/tokens.js";
import { projectHealth, globalMetrics } from "../services/health.service.js";
import { neighborhood, rebuildManualLinks, rebuildSemanticLinks } from "../services/graph.service.js";
import { embedMemory } from "../repositories/vector.repo.js";

export function registerMaintenanceTools(server: McpServer): void {
  server.tool(
    "clean",
    `List/archive stale memories (not accessed in N+ days). actions: list | archive | delete.`,
    { project: z.string(), action: z.enum(["list", "archive", "delete"]).optional().default("list"), key: z.string().optional(), days: z.number().optional().default(45) },
    ({ project, action, key, days }) => {
      try {
        const threshold = days ?? 45;
        const act = action ?? "list";
        if (act === "delete") {
          if (!key) return err("'key' is required for action=delete");
          const r = db.prepare("DELETE FROM memories WHERE project = ? AND key = ?").run(project, key);
          if (r.changes === 0) return err(`No memory found with key '${key}'`);
          return ok({ deleted: true, project, key });
        }
        const stale = db.prepare(
          `SELECT key, category, value, last_accessed_at, created_at FROM memories
           WHERE project = ? AND key != '_snapshot'
             AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-' || ? || ' days'))
           ORDER BY last_accessed_at ASC NULLS FIRST`
        ).all(project, threshold) as Array<{ key: string; category: string; value: string; last_accessed_at: string | null; created_at: string }>;

        if (act === "archive") {
          if (stale.length === 0) return ok({ archived: 0, message: `No stale memories (threshold ${threshold}d)` });
          const keys = stale.map((m) => m.key);
          const ph = keys.map(() => "?").join(",");
          db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${ph})`).run(project, ...keys);
          return ok({ archived: stale.length, project, threshold_days: threshold, deleted_keys: keys });
        }
        return ok({
          project, threshold_days: threshold, stale_count: stale.length,
          stale_memories: stale.map((m) => ({ key: m.key, category: m.category, last_accessed: m.last_accessed_at ?? "never", created_at: m.created_at, preview: truncate(m.value, 100) })),
          hint: stale.length > 0 ? `clean(project, action='archive') to delete all` : `Project is clean.`,
        });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "health",
    `Project integrity diagnostics — actionable warnings (stale, expired, snapshot age, overlap, missing embeddings, token bloat).`,
    { project: z.string() },
    ({ project }) => { try { return ok(projectHealth(project)); } catch (e) { return err(errOf(e)); } }
  );

  server.tool(
    "metrics",
    `Usage + semantic-coverage metrics. Omit project for global view.`,
    { project: z.string().optional() },
    ({ project }) => { try { return ok(globalMetrics(project)); } catch (e) { return err(errOf(e)); } }
  );

  server.tool(
    "graph",
    `Knowledge graph around a memory key. Returns the BFS neighborhood (nodes + edges) up to depth hops.
Edges are manual (from related) + semantic (embedding similarity). rebuild=true recomputes edges first.`,
    { project: z.string(), key: z.string(), depth: z.number().optional().default(1), rebuild: z.boolean().optional() },
    async ({ project, key, depth, rebuild }) => {
      try {
        if (rebuild) { rebuildManualLinks(project); await rebuildSemanticLinks(project); }
        return ok(neighborhood(project, key, depth ?? 1));
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "compress",
    `Collapse multiple related memories into one structured memory. preview_only:true to review first.`,
    { project: z.string(), keys: z.array(z.string()), new_key: z.string(), new_value: z.string(), new_category: z.enum(["fact", "pattern", "preference", "warning", "note", "rule"]).optional().default("fact"), preview_only: z.boolean().optional() },
    async ({ project, keys, new_key, new_value, new_category, preview_only }) => {
      try {
        if (keys.length < 2) return err("compress requires at least 2 keys");
        const ph = keys.map(() => "?").join(",");
        const sources = db.prepare(`SELECT key, value, category, importance, related FROM memories WHERE project = ? AND key IN (${ph})`).all(project, ...keys) as Array<{ key: string; value: string; category: string; importance: number; related: string }>;
        if (sources.length === 0) return err(`No memories found for keys: ${keys.join(", ")}`);
        if (preview_only) return ok({ preview: true, project, source_memories: sources.map((m) => ({ key: m.key, category: m.category, importance: m.importance, value: m.value })), hint: "Re-run without preview_only to execute." });

        const maxImp = Math.max(...sources.map((m) => m.importance ?? 5));
        const allRelated = Array.from(new Set(sources.flatMap((m) => { try { return JSON.parse(m.related || "[]"); } catch { return []; } }).filter((k: string) => !keys.includes(k))));
        db.prepare(`DELETE FROM memories WHERE project = ? AND key IN (${ph})`).run(project, ...keys);
        const id = uuid();
        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, importance, related, tool, updated_at, embedded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code', datetime('now'), NULL)
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, category = excluded.category, importance = excluded.importance, related = excluded.related, updated_at = excluded.updated_at, embedded_at = NULL`
        ).run(id, project, new_key, new_value, new_category ?? "fact", maxImp, JSON.stringify(allRelated));
        const saved = db.prepare("SELECT id FROM memories WHERE project = ? AND key = ?").get(project, new_key) as { id: string } | undefined;
        if (saved) await embedMemory(saved.id);

        return ok({ compressed: true, project, deleted_keys: sources.map((m) => m.key), new_memory: { key: new_key, category: new_category ?? "fact", importance: maxImp }, tokens_saved_estimate: estimateTokens(sources.map((m) => m.value).join("")) });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "generate_rules",
    `Convert project memories into CLAUDE.md-ready markdown rules.`,
    { project: z.string(), categories: z.array(z.enum(["rule", "warning", "pattern", "preference", "fact"])).optional() },
    ({ project, categories }) => {
      try {
        const cats = categories?.length ? categories : ["rule", "warning", "pattern", "preference"];
        const ph = cats.map(() => "?").join(",");
        const memories = db.prepare(
          `SELECT key, value, category FROM memories WHERE project = ? AND category IN (${ph}) AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY CASE category WHEN 'rule' THEN 0 WHEN 'warning' THEN 1 WHEN 'pattern' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END, importance DESC, key`
        ).all(project, ...cats) as Array<{ key: string; value: string; category: string }>;
        if (memories.length === 0) return text(`No memories in [${cats.join(", ")}] for '${project}'.`);
        const grouped: Record<string, typeof memories> = {};
        for (const m of memories) (grouped[m.category] ??= []).push(m);
        let md = `# Project Rules: ${project}\n# Generated by ULTRON Hub v8\n\n`;
        const section = (cat: string, title: string, comment: string, withKey = false) => {
          if (!grouped[cat]) return;
          md += `## ${title}\n<!-- ${comment} -->\n\n`;
          for (const m of grouped[cat]) md += withKey ? `- **${m.key}**: ${m.value}\n` : `- ${m.value}\n`;
          md += "\n";
        };
        section("rule", "Non-negotiable Rules", "Always active — injected first");
        section("warning", "Avoid", "Learned from real experience");
        section("pattern", "Follow", "Patterns that work in this project");
        section("preference", "Preferences", "Team conventions");
        section("fact", "Facts", "Key project data", true);
        md += `---\n_Generated by ULTRON Hub v8 on ${new Date().toISOString().split("T")[0]}_\n`;
        return text(md);
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "token_budget",
    `Estimate tokens a full recall() would consume, with optimization suggestions.`,
    { project: z.string() },
    ({ project }) => {
      try {
        const memories = db.prepare("SELECT key, value, category FROM memories WHERE project = ? ORDER BY updated_at DESC LIMIT 30").all(project);
        const sessions = db.prepare("SELECT tool, summary, files, ended_at FROM sessions WHERE project = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 5").all(project);
        const tasks = db.prepare("SELECT text, priority FROM tasks WHERE project = ? AND status = 'pending'").all(project);
        const decisions = db.prepare("SELECT topic, choice, reason FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT 10").all(project);
        const staleCount = (db.prepare(`SELECT COUNT(*) c FROM memories WHERE project = ? AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now','-45 days'))`).get(project) as { c: number }).c;
        const sections = {
          memories: { count: (memories as unknown[]).length, tokens: estimateTokens(JSON.stringify(memories)) },
          sessions: { count: (sessions as unknown[]).length, tokens: estimateTokens(JSON.stringify(sessions)) },
          tasks: { count: (tasks as unknown[]).length, tokens: estimateTokens(JSON.stringify(tasks)) },
          decisions: { count: (decisions as unknown[]).length, tokens: estimateTokens(JSON.stringify(decisions)) },
        };
        const total = Object.values(sections).reduce((s, x) => s + x.tokens, 0);
        const suggestions: string[] = [];
        if (total > 5000 && sections.memories.count > 15) suggestions.push("Use session_start slim:true (~80% memory token cut)");
        if (sections.tasks.count > 20) suggestions.push("Mark completed tasks done");
        if (staleCount > 5) suggestions.push(`${staleCount} stale memories — clean(project,'archive')`);
        if (total > 8000) suggestions.push("Run health(project) for compression opportunities");
        return ok({ project, total_estimated_tokens: total, sections, stale_memories: staleCount, ...(suggestions.length && { suggestions }), ...(total > 8000 && { warning: `High token usage (${total}).` }) });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "export_project",
    `Export all data for a project as JSON (backup / cross-machine sync).`,
    { project: z.string() },
    ({ project }) => {
      try {
        const t = (n: string) => db.prepare(`SELECT * FROM ${n} WHERE project = ?`).all(project);
        const memories = t("memories"), sessions = t("sessions"), decisions = t("decisions"), tasks = t("tasks");
        return ok({ ultron_version: "8.0.0", exported_at: now(), project, counts: { memories: memories.length, sessions: sessions.length, decisions: decisions.length, tasks: tasks.length }, data: { memories, sessions, decisions, tasks } });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "import_project",
    `Import an exported JSON blob. strategy: merge (upsert keeping newer) | replace (wipe then insert).`,
    { data: z.string(), strategy: z.enum(["merge", "replace"]).optional().default("merge") },
    ({ data: jsonStr, strategy }) => {
      try {
        const payload = JSON.parse(jsonStr);
        if (!payload.project || !payload.data) return err("Invalid export format.");
        const { project, data } = payload;
        const strat = strategy ?? "merge";
        const tx = db.transaction(() => {
          const counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0 };
          if (strat === "replace") for (const t of ["memories", "sessions", "decisions", "tasks"]) db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
          const memStmt = db.prepare(
            `INSERT INTO memories (id, project, key, value, category, importance, tool, expires_at, last_accessed_at, access_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (project, key) DO UPDATE SET
               value = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.value ELSE memories.value END,
               category = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.category ELSE memories.category END,
               importance = CASE WHEN excluded.updated_at > memories.updated_at THEN excluded.importance ELSE memories.importance END,
               updated_at = MAX(excluded.updated_at, memories.updated_at),
               access_count = MAX(excluded.access_count, memories.access_count),
               embedded_at = NULL`
          );
          for (const m of data.memories ?? []) { memStmt.run(m.id, m.project, m.key, m.value, m.category, m.importance ?? 5, m.tool, m.expires_at, m.last_accessed_at, m.access_count ?? 0, m.created_at, m.updated_at); counts.memories++; }
          const sesStmt = db.prepare(`INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const s of data.sessions ?? []) { sesStmt.run(s.id, s.project, s.tool, s.summary, typeof s.files === "string" ? s.files : JSON.stringify(s.files ?? []), s.started_at, s.ended_at, s.created_at); counts.sessions++; }
          const decStmt = db.prepare(`INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const d of data.decisions ?? []) { decStmt.run(d.id, d.project, d.topic, d.choice, d.reason, d.tool, d.created_at); counts.decisions++; }
          const taskStmt = db.prepare(`INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tool, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const t of data.tasks ?? []) { taskStmt.run(t.id, t.project, t.text, t.status, t.priority, t.tool, t.created_at, t.done_at); counts.tasks++; }
          return counts;
        });
        return ok({ imported: true, project, strategy: strat, counts: tx() });
      } catch (e) { return err(errOf(e)); }
    }
  );
}
