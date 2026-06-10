// ── ULTRON v9 — tool registry ─────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "./memory.tools.js";
import { registerWorkTools } from "./work.tools.js";
import { registerSessionTools } from "./session.tools.js";
import { registerMaintenanceTools } from "./maintenance.tools.js";
import { registerIntelligenceTools } from "./intelligence.tools.js";
import { registerSyncTools } from "./sync.tools.js";
import { registerAgentTools } from "./agent.tools.js";

export function registerAllTools(server: McpServer): void {
  registerMemoryTools(server);
  registerWorkTools(server);
  registerSessionTools(server);
  registerMaintenanceTools(server);
  registerIntelligenceTools(server);
  registerSyncTools(server);
  registerAgentTools(server);
}
