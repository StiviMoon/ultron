// ── ULTRON v8 — structured logger ─────────────────────────────────────────────
// Logs to ~/.ultron/ultron.log. NEVER writes to stdout — that channel is the
// MCP stdio transport and any stray byte corrupts the protocol. stderr + file only.

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ULTRON_DIR = process.env.ULTRON_DIR ?? join(homedir(), ".ultron");
const LOG_PATH = process.env.ULTRON_LOG_PATH ?? join(ULTRON_DIR, "ultron.log");

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: Level = (process.env.ULTRON_LOG_LEVEL as Level) ?? "info";

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta && { meta }) });
  try {
    mkdirSync(ULTRON_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* logging must never throw */
  }
  // stderr mirror for live debugging; safe under MCP stdio
  if (level === "error" || level === "warn") console.error("[ULTRON]", msg);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};
