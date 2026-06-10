// ── ULTRON v9 — MCP tool wrapper ──────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { ok, err, errOf, text, type McpResult } from "./result.js";
import { log } from "./logger.js";

type ToolHandler<T> = (args: T) => unknown | Promise<unknown>;

export function defineTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: T,
  handler: ToolHandler<z.infer<z.ZodObject<T>>>
): void {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await handler(args);
      if (isMcpResult(result)) return result;
      return ok(result as Record<string, unknown>);
    } catch (e) {
      const msg = errOf(e);
      log.error(`tool ${name} failed`, { error: msg });
      return err(msg);
    }
  });
}

/** Like defineTool but returns plain markdown via text(). */
export function defineTextTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: T,
  handler: ToolHandler<z.infer<z.ZodObject<T>>>
): void {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await handler(args);
      if (typeof result === "string") return text(result);
      if (isMcpResult(result)) return result;
      return text(String(result));
    } catch (e) {
      const msg = errOf(e);
      log.error(`tool ${name} failed`, { error: msg });
      return err(msg);
    }
  });
}

function isMcpResult(v: unknown): v is McpResult {
  return typeof v === "object" && v !== null && "content" in v && Array.isArray((v as McpResult).content);
}
