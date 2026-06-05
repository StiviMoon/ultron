// ── ULTRON v8 — autonomous daemon tasks ───────────────────────────────────────
// Background maintenance run against ULTRON. Logged to agent_runs. Each task is
// pure-ish: pass dryRun to preview without mutating.

import { db, uuid, isVecEnabled } from "../db/connection.js";
import { projectHealth } from "../services/health.service.js";
import { rebuildManualLinks, rebuildSemanticLinks } from "../services/graph.service.js";
import { backfillEmbeddings } from "../repositories/vector.repo.js";
import { log } from "../lib/logger.js";

const AGENT = "ultron-daemon";

function logRun(action: string, project: string | null, detail: string): void {
  db.prepare("INSERT INTO agent_runs (id, agent, project, action, detail, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(
    uuid(), AGENT, project, action, detail
  );
}

function allProjects(): string[] {
  return (db.prepare(
    `SELECT DISTINCT project FROM (SELECT project FROM memories UNION SELECT project FROM tasks)`
  ).all() as Array<{ project: string }>).map((r) => r.project);
}

/** nightly-curator: purge expired, checkpoint WAL, report health per project. */
export function nightlyCurator(dryRun: boolean): Record<string, unknown> {
  const projects = allProjects();
  const report: Record<string, unknown> = { projects: projects.length, dryRun };
  let purged = 0;

  for (const p of projects) {
    if (!dryRun) {
      purged += db.prepare(
        `DELETE FROM memories WHERE project = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
      ).run(p).changes;
    }
  }
  report.purged_expired = purged;

  const degraded = projects
    .map((p) => projectHealth(p))
    .filter((h) => h.health_score < 80)
    .map((h) => ({ project: h.project, score: h.health_score, status: h.status }));
  report.needs_attention = degraded;

  if (!dryRun) {
    const wc = db.pragma("wal_checkpoint(TRUNCATE)");
    report.wal_checkpoint = wc;
    logRun("nightly-curator", null, `purged=${purged} degraded=${degraded.length}`);
  }
  return report;
}

/** memory-gardener: ensure embeddings exist + rebuild graph links per project. */
export async function memoryGardener(dryRun: boolean): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { dryRun, vec_enabled: isVecEnabled() };
  if (!isVecEnabled()) { report.skipped = "sqlite-vec unavailable"; return report; }

  const missing = (db.prepare("SELECT COUNT(*) c FROM memories WHERE embedded_at IS NULL").get() as { c: number }).c;
  report.embeddings_missing = missing;

  if (!dryRun && missing > 0) {
    report.embedded = await backfillEmbeddings(64);
  }

  if (!dryRun) {
    let manual = 0, semantic = 0;
    for (const p of allProjects()) {
      manual += rebuildManualLinks(p);
      semantic += await rebuildSemanticLinks(p);
    }
    report.links = { manual, semantic };
    logRun("memory-gardener", null, `embedded_missing=${missing} links_manual=${manual} links_semantic=${semantic}`);
  }
  return report;
}

export async function runAll(dryRun: boolean): Promise<void> {
  log.info("daemon run start", { dryRun });
  const nc = nightlyCurator(dryRun);
  log.info("nightly-curator done", nc);
  const mg = await memoryGardener(dryRun);
  log.info("memory-gardener done", mg);
  // eslint-disable-next-line no-console
  console.error("[ultron-daemon]", JSON.stringify({ nightlyCurator: nc, memoryGardener: mg }, null, 2));
}
