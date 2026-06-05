// ── ULTRON v8 — smoke test against a DB copy ──────────────────────────────────
// Runs migration (via connection import), backfills embeddings, exercises hybrid
// search + graph. Set ULTRON_DB_PATH to a COPY before running.

import { db, isVecEnabled } from "../src/db/connection.js";
import { backfillEmbeddings } from "../src/repositories/vector.repo.js";
import { searchMemories, fetchProjectContext } from "../src/services/recall.service.js";
import { rebuildManualLinks, rebuildSemanticLinks, neighborhood } from "../src/services/graph.service.js";
import { projectHealth, globalMetrics } from "../src/services/health.service.js";

function count(sql: string, ...a: unknown[]): number {
  return (db.prepare(sql).get(...a) as { c: number }).c;
}

async function main() {
  console.log("vec enabled:", isVecEnabled());
  console.log("schema_version:", (db.prepare("SELECT value FROM _meta WHERE key='schema_version'").get() as { value: string })?.value);

  // Post-migration data integrity
  const total = count("SELECT COUNT(*) c FROM memories");
  const mj = count("SELECT COUNT(*) c FROM memories WHERE project='mj'");
  const MJ = count("SELECT COUNT(*) c FROM memories WHERE project='MJ'");
  const projects = count("SELECT COUNT(DISTINCT project) c FROM memories");
  console.log(`memories total=${total} | mj=${mj} MJ=${MJ} | distinct projects=${projects}`);

  // Backfill embeddings
  const t0 = Date.now();
  const embedded = await backfillEmbeddings(64);
  console.log(`embedded ${embedded} memories in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("vec_memories rows:", count("SELECT COUNT(*) c FROM vec_memories"));

  // Hybrid vs keyword search — conceptual query that FTS5 would miss
  const q = "evitar errores de zona horaria en fechas";
  for (const mode of ["keyword", "semantic", "hybrid"] as const) {
    const res = await searchMemories(q, ["mj"], mode, 5);
    console.log(`\nsearch[${mode}] "${q}" → ${res.length} hits:`);
    for (const r of res.slice(0, 3)) console.log(`  - [${r.category}] ${r.key}`);
  }

  // Knowledge graph
  rebuildManualLinks("mj");
  await rebuildSemanticLinks("mj", 0.5, 3);
  console.log("\nmemory_links:", count("SELECT COUNT(*) c FROM memory_links"));
  const aKey = (db.prepare("SELECT key FROM memories WHERE project='mj' AND key != '_snapshot' ORDER BY access_count DESC LIMIT 1").get() as { key: string })?.key;
  if (aKey) {
    const nb = neighborhood("mj", aKey, 1);
    console.log(`graph around '${aKey}': ${nb.nodes.length} nodes, ${nb.edges.length} edges`);
  }

  // Context + health + metrics
  const ctx = fetchProjectContext("mj", { slim: true });
  console.log("\nrecall(mj, slim) rules:", (ctx.rules?.length ?? 0), "memories:", (ctx.memories?.length ?? 0));
  console.log("health(mj):", projectHealth("mj").health_score, projectHealth("mj").status);
  console.log("metrics global:", JSON.stringify(globalMetrics().counts), "coverage:", globalMetrics().semantic_coverage);

  console.log("\n✅ smoke test complete");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
