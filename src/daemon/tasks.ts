// ── ULTRON v9 — autonomous daemon tasks ───────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { db, uuid, isVecEnabled } from "../db/connection.js";
import { projectHealth } from "../services/health.service.js";
import { rebuildManualLinks, rebuildSemanticLinksIncremental } from "../services/graph.service.js";
import { backfillEmbeddings } from "../repositories/vector.repo.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import { log } from "../lib/logger.js";

const AGENT = "ultron-daemon";
const ULTRON_DIR = process.env.ULTRON_DIR ?? join(homedir(), ".ultron");
const BACKUP_DIR = join(ULTRON_DIR, "backups");
const MAX_BACKUPS = 7;

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

function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(key, value);
}

/** nightly-curator: purge expired, decay importance, checkpoint WAL, report health. */
export function nightlyCurator(dryRun: boolean): Record<string, unknown> {
  const projects = allProjects();
  const report: Record<string, unknown> = { projects: projects.length, dryRun };
  let purged = 0;
  let decayed = 0;

  if (!dryRun) {
    purged = memoryRepo.purgeExpiredAll();
    for (const p of projects) decayed += memoryRepo.decayImportance(p, 60);
  }
  report.purged_expired = purged;
  report.decayed_importance = decayed;

  const degraded = projects
    .map((p) => projectHealth(p))
    .filter((h) => h.health_score < 80)
    .map((h) => ({ project: h.project, score: h.health_score, status: h.status }));
  report.needs_attention = degraded;

  if (!dryRun) {
    const wc = db.pragma("wal_checkpoint(TRUNCATE)");
    report.wal_checkpoint = wc;
    logRun("nightly-curator", null, `purged=${purged} decayed=${decayed} degraded=${degraded.length}`);
  }
  return report;
}

/** memory-gardener: embeddings + incremental graph links. */
export async function memoryGardener(dryRun: boolean): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { dryRun, vec_enabled: isVecEnabled() };
  if (!isVecEnabled()) { report.skipped = "sqlite-vec unavailable"; return report; }

  const missing = (db.prepare("SELECT COUNT(*) c FROM memories WHERE embedded_at IS NULL").get() as { c: number }).c;
  report.embeddings_missing = missing;

  if (!dryRun && missing > 0) {
    report.embedded = await backfillEmbeddings(64);
  }

  if (!dryRun) {
    const since = getMeta("last_gardener_run");
    let manual = 0, semantic = 0;
    for (const p of allProjects()) {
      manual += rebuildManualLinks(p);
      semantic += await rebuildSemanticLinksIncremental(p, since);
    }
    setMeta("last_gardener_run", new Date().toISOString());
    report.links = { manual, semantic };
    logRun("memory-gardener", null, `embedded_missing=${missing} links_manual=${manual} links_semantic=${semantic}`);
  }
  return report;
}

/** Rotating backup via VACUUM INTO — consistent snapshot without blocking. */
export function rotateBackup(dryRun: boolean): Record<string, unknown> {
  const report: Record<string, unknown> = { dryRun };
  if (dryRun) return { ...report, skipped: "dry run" };

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = join(BACKUP_DIR, `ultron-${stamp}.db`);

  try {
    db.prepare("VACUUM INTO ?").run(dest);
    report.backup = dest;

    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("ultron-") && f.endsWith(".db"))
      .sort()
      .reverse();
    const removed: string[] = [];
    for (const f of files.slice(MAX_BACKUPS)) {
      unlinkSync(join(BACKUP_DIR, f));
      removed.push(f);
    }
    report.removed_old = removed;
    logRun("backup", null, `created=${dest} removed=${removed.length}`);
  } catch (e) {
    report.error = String(e);
    log.error("backup failed", { error: String(e) });
  }
  return report;
}

export async function runAll(dryRun: boolean): Promise<void> {
  log.info("daemon run start", { dryRun });
  const nc = nightlyCurator(dryRun);
  log.info("nightly-curator done", nc);
  const mg = await memoryGardener(dryRun);
  log.info("memory-gardener done", mg);
  const bk = rotateBackup(dryRun);
  log.info("backup done", bk);
  // eslint-disable-next-line no-console
  console.error("[ultron-daemon]", JSON.stringify({ nightlyCurator: nc, memoryGardener: mg, backup: bk }, null, 2));
}
