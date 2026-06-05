// ── ULTRON v8 — daemon entrypoint ─────────────────────────────────────────────
// Usage:
//   ultron-daemon --once         run all maintenance once, then exit
//   ultron-daemon --once --dry    preview only, no mutations
//   ultron-daemon                 long-running; runs every INTERVAL_MS (default 6h)
//
// Separate process from the MCP stdio server. Shares the same SQLite DB via WAL.

import { runAll } from "./tasks.js";
import { log } from "../lib/logger.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry") || args.has("--dry-run");
const once = args.has("--once");
const INTERVAL_MS = Number(process.env.ULTRON_DAEMON_INTERVAL_MS ?? 6 * 3600 * 1000);

async function main() {
  if (once) {
    await runAll(dryRun);
    process.exit(0);
  }
  log.info("ultron-daemon started (loop)", { intervalMs: INTERVAL_MS, dryRun });
  // run immediately, then on interval
  await runAll(dryRun);
  setInterval(() => { void runAll(dryRun); }, INTERVAL_MS);
}

main().catch((e) => { log.error("daemon fatal", { error: String(e) }); process.exit(1); });
