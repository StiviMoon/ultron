// ── ULTRON v9 — MCP prompts (guided workflows) ────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerAllPrompts(server: McpServer): void {
  server.prompt(
    "start-session",
    "Guided workflow to start a ULTRON work session",
    { project: z.string(), tool: z.string() },
    ({ project, tool }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Start working on project "${project}" using tool "${tool}".

Follow this protocol:
1. Call session_start("${project}", "${tool}", slim=true)
2. Read rules and warnings FIRST before any code changes
3. Review pending_tasks and confirm priority with the user
4. During work: remember() for discoveries, decision() for choices, task() for backlog
5. At end: session_end("${project}", "${tool}", summary, files)

If unsure about ULTRON tools, call onboard() first.`,
        },
      }],
    })
  );

  server.prompt(
    "end-session",
    "Guided workflow to close a ULTRON work session",
    { project: z.string(), tool: z.string(), summary: z.string() },
    ({ project, tool, summary }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Close the work session for "${project}".

1. Call session_end("${project}", "${tool}", "${summary}", [list of files touched])
2. Verify snapshot_saved: true in the response
3. If pending high-priority tasks remain, mention them to the user

Never skip session_end — the next session_start loads the snapshot.`,
        },
      }],
    })
  );

  server.prompt(
    "audit-memory",
    "Guided workflow to audit and optimize project memory",
    { project: z.string() },
    ({ project }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Audit memory health for project "${project}".

1. Call health("${project}") — review health_score and issues
2. Call token_budget("${project}") — check token footprint
3. If stale memories found: clean("${project}", action="list") then archive if safe
4. If prefix overlap found: compress overlapping keys
5. Call generate_rules("${project}", format="claude") to export rules

Report findings and recommended actions to the user.`,
        },
      }],
    })
  );
}
