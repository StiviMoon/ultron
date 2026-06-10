// ── ULTRON v9 — init command (autoconfig MCP) ─────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// When bundled, init lives in dist/index.js — use this file as the MCP server entry.
const ULTRON_ENTRY = fileURLToPath(import.meta.url);

interface McpConfig {
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

export async function runInit(): Promise<void> {
  const targets = [
    { name: "Claude Code (global)", path: join(homedir(), ".mcp.json") },
    { name: "Cursor (global)", path: join(homedir(), ".cursor", "mcp.json") },
  ];

  console.log("ULTRON Hub v9 — MCP init\n");
  console.log(`Server entry: ${ULTRON_ENTRY}\n`);

  for (const target of targets) {
    try {
      const dir = dirname(target.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      let config: McpConfig = {};
      if (existsSync(target.path)) {
        config = JSON.parse(readFileSync(target.path, "utf-8")) as McpConfig;
      }
      config.mcpServers ??= {};
      config.mcpServers.ultron = { command: "node", args: [ULTRON_ENTRY] };
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n");
      console.log(`✓ ${target.name}: ${target.path}`);
    } catch (e) {
      console.error(`✗ ${target.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\nRestart Claude Code / Cursor to connect.");
  console.log("First call: onboard() or session_start(\"my-project\", \"cursor\")");
}
