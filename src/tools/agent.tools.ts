// ── ULTRON v9 — agent ecosystem tools ─────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../lib/define-tool.js";
import { withActions } from "../lib/next-actions.js";
import * as agentRepo from "../repositories/agent.repo.js";

export function registerAgentTools(server: McpServer): void {
  defineTool(
    server, "agent_register",
    `Register an agent in the ULTRON ecosystem.
WHEN: A subagent or daemon starts working on a project.
Example: agent_register("ultron-architect", type="subagent", capabilities=["architecture"])
type: subagent (interactive) | daemon (background).`,
    { name: z.string(), type: z.enum(["subagent", "daemon"]).optional().default("subagent"), capabilities: z.array(z.string()).optional() },
    ({ name, type, capabilities }) => {
      agentRepo.registerAgent(name, type ?? "subagent", capabilities ?? []);
      return withActions({ registered: true, name, type: type ?? "subagent", capabilities: capabilities ?? [] }, ["Use agent_log to audit runs"]);
    }
  );

  defineTool(
    server, "agent_log",
    `Record what an agent did — audit entry in agent_runs.
WHEN: Start/end of agent work, or significant milestones.
Example: agent_log("ultron-architect", "audit-complete", project="api", detail="score 71/100")
Use ended=true + run_id to close an open run.`,
    { agent: z.string(), action: z.string(), project: z.string().optional(), detail: z.string().optional(), run_id: z.string().optional(), ended: z.boolean().optional() },
    ({ agent, action, project, detail, run_id, ended }) => {
      if (run_id && ended) {
        agentRepo.endRun(run_id, detail ?? null);
        return { logged: true, run_id, ended: true };
      }
      const id = agentRepo.logRun(agent, action, project ?? null, detail ?? null);
      return { logged: true, run_id: id, agent, action };
    }
  );

  defineTool(
    server, "agent_handoff",
    `One agent leaves structured context for another. Stored as high-importance memory.
WHEN: Subagent finishes and parent/other agent needs to continue.
Example: agent_handoff("api", from_agent="auditor", to_agent="implementer", context="Fix P0 vector cleanup first")
Receiving agent reads via recall/search for key handoff-{to_agent}.`,
    { project: z.string(), from_agent: z.string(), to_agent: z.string(), context: z.string() },
    async ({ project, from_agent, to_agent, context }) => {
      const { key } = await agentRepo.handoff(project, from_agent, to_agent, context);
      return withActions({ handed_off: true, project, from_agent, to_agent, key }, [`Agent ${to_agent} should search("${project}", "${key}") or recall()`]);
    }
  );
}
