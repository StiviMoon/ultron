/**
 * ULTRON Hub — MCP Server v8
 *
 * Persistent, semantic developer memory for Claude Code, Cursor, and any MCP client.
 * Local SQLite + sqlite-vec, local embeddings (transformers.js). Zero config, private.
 *
 * Architecture: tools → services → repositories → db (clean layering).
 * Tools live in src/tools/*, registered via registry.ts. This file only boots the server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/registry.js";
import { log } from "./lib/logger.js";

const server = new McpServer({ name: "ultron-hub", version: "8.0.0" });

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("ULTRON Hub v8 connected");
