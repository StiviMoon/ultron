// ── ULTRON v8 — agent ecosystem tools ─────────────────────────────────────────
// agent_register · agent_log · agent_handoff — let autonomous/interactive agents
// register, audit their runs, and pass structured context to each other.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, uuid } from "../db/connection.js";
import { ok, err, errOf, now } from "../lib/result.js";

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "agent_register",
    `Register an agent in the ULTRON ecosystem. type: subagent (interactive) | daemon (background).`,
    { name: z.string(), type: z.enum(["subagent", "daemon"]).optional().default("subagent"), capabilities: z.array(z.string()).optional() },
    ({ name, type, capabilities }) => {
      try {
        db.prepare(
          `INSERT INTO agents (id, name, type, capabilities) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET type = excluded.type, capabilities = excluded.capabilities`
        ).run(uuid(), name, type ?? "subagent", JSON.stringify(capabilities ?? []));
        return ok({ registered: true, name, type: type ?? "subagent", capabilities: capabilities ?? [] });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "agent_log",
    `Record what an agent did — an audit entry in agent_runs. Use ended=true to close an open run.`,
    { agent: z.string(), action: z.string(), project: z.string().optional(), detail: z.string().optional(), run_id: z.string().optional(), ended: z.boolean().optional() },
    ({ agent, action, project, detail, run_id, ended }) => {
      try {
        if (run_id && ended) {
          db.prepare("UPDATE agent_runs SET ended_at = ?, detail = COALESCE(?, detail) WHERE id = ?").run(now(), detail ?? null, run_id);
          return ok({ logged: true, run_id, ended: true });
        }
        const id = uuid();
        db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail) VALUES (?, ?, ?, ?, ?)").run(id, agent, project ?? null, action, detail ?? null);
        return ok({ logged: true, run_id: id, agent, action });
      } catch (e) { return err(errOf(e)); }
    }
  );

  server.tool(
    "agent_handoff",
    `One agent leaves structured context for another. Stored as a high-importance memory keyed by target agent.
The receiving agent reads it via recall/search. Enables shared memory across the agent ecosystem.`,
    { project: z.string(), from_agent: z.string(), to_agent: z.string(), context: z.string() },
    ({ project, from_agent, to_agent, context }) => {
      try {
        const key = `handoff-${to_agent}`;
        db.prepare(
          `INSERT INTO memories (id, project, key, value, category, importance, tool, agent, updated_at, embedded_at)
           VALUES (?, ?, ?, ?, 'note', 8, 'agent', ?, datetime('now'), NULL)
           ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, agent = excluded.agent, updated_at = excluded.updated_at, embedded_at = NULL`
        ).run(uuid(), project, key, `[from ${from_agent} → ${to_agent}] ${context}`, from_agent);
        return ok({ handed_off: true, project, from_agent, to_agent, key });
      } catch (e) { return err(errOf(e)); }
    }
  );
}
