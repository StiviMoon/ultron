// ── ULTRON v9 — MCP resources ─────────────────────────────────────────────────

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as projectRepo from "../repositories/project.repo.js";
import { fetchProjectContext } from "../services/recall.service.js";
import * as memoryRepo from "../repositories/memory.repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readDoc(name: string): string {
  try { return readFileSync(join(REPO_ROOT, name), "utf-8"); }
  catch { return `# ${name} not found`; }
}

export function registerAllResources(server: McpServer): void {
  server.registerResource(
    "projects",
    "ultron://projects",
    { mimeType: "application/json", description: "All projects with stats" },
    async () => ({
      contents: [{ uri: "ultron://projects", mimeType: "application/json", text: JSON.stringify(projectRepo.listWithStats(), null, 2) }],
    })
  );

  server.registerResource(
    "project-context",
    new ResourceTemplate("ultron://{project}/context", { list: undefined }),
    { mimeType: "application/json", description: "Full project context (slim)" },
    async (uri, variables) => {
      const project = variables.project as string;
      const ctx = fetchProjectContext(project, { slim: true });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx, null, 2) }],
      };
    }
  );

  server.registerResource(
    "agent-guide",
    "ultron://agent-guide",
    { mimeType: "text/markdown", description: "AGENTS.md — instant protocol for AI agents" },
    async () => ({
      contents: [{ uri: "ultron://agent-guide", mimeType: "text/markdown", text: readDoc("AGENTS.md") }],
    })
  );

  server.registerResource(
    "agent-example",
    "ultron://examples/session-workflow",
    { mimeType: "text/markdown", description: "Real-world 3-session workflow example" },
    async () => ({
      contents: [{ uri: "ultron://examples/session-workflow", mimeType: "text/markdown", text: readDoc("docs/examples/session-workflow.md") }],
    })
  );

  server.registerResource(
    "project-rules",
    new ResourceTemplate("ultron://{project}/rules", { list: undefined }),
    { mimeType: "application/json", description: "Project rules and warnings" },
    async (uri, variables) => {
      const project = variables.project as string;
      const rules = memoryRepo.getRules(project);
      const warnings = memoryRepo.getScoredMemories(project, 50).filter((m) => m.category === "warning");
      return {
        contents: [{
          uri: uri.href, mimeType: "application/json",
          text: JSON.stringify({ project, rules, warnings }, null, 2),
        }],
      };
    }
  );
}
