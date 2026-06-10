/**
 * ULTRON Hub — MCP Server v9
 *
 * Persistent, semantic developer memory for Claude Code, Cursor, and any MCP client.
 * Local SQLite + sqlite-vec, local embeddings (transformers.js). Zero config, private.
 *
 * Architecture: tools → services → repositories → db (clean layering).
 * Usage: node dist/index.js | npx ultron-hub | ultron-hub init
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/registry.js";
import { registerAllResources } from "./resources/registry.js";
import { registerAllPrompts } from "./prompts/registry.js";
import { warmupEmbeddings } from "./services/embedding.service.js";
import { runInit } from "./cli/init.js";
import { log } from "./lib/logger.js";

const VERSION = "9.0.0";

if (process.argv.includes("init")) {
  await runInit();
  process.exit(0);
}

const server = new McpServer({ name: "ultron-hub", version: VERSION });

registerAllTools(server);
registerAllResources(server);
registerAllPrompts(server);

warmupEmbeddings();

const transport = new StdioServerTransport();
await server.connect(transport);
log.info(`ULTRON Hub v${VERSION} connected`);
