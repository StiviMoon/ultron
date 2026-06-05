// ── ULTRON v8 — vector repository (sqlite-vec bridge) ─────────────────────────
// vec_memories.rowid mirrors memories.rowid. We embed lazily and store here.

import { db, isVecEnabled } from "../db/connection.js";
import { embedMany, embedOne } from "../services/embedding.service.js";
import { log } from "../lib/logger.js";

/** Persist an embedding for a memory rowid. No-op if vec disabled.
 *  sqlite-vec's vec0 PK requires a BigInt rowid — plain JS numbers are rejected. */
function upsertVector(rowid: number, vec: Float32Array): void {
  if (!isVecEnabled()) return;
  const rid = BigInt(rowid);
  db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(rid);
  db.prepare("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)").run(rid, vec);
}

/** Embed + store a single memory. Marks memories.embedded_at on success. */
export async function embedMemory(memoryId: string): Promise<boolean> {
  if (!isVecEnabled()) return false;
  const row = db
    .prepare("SELECT rowid, key, value FROM memories WHERE id = ?")
    .get(memoryId) as { rowid: number; key: string; value: string } | undefined;
  if (!row) return false;
  const vec = await embedOne(`${row.key}\n${row.value}`);
  if (!vec) return false;
  upsertVector(row.rowid, vec);
  db.prepare("UPDATE memories SET embedded_at = datetime('now') WHERE id = ?").run(memoryId);
  return true;
}

/** Backfill embeddings for all memories missing one. Batched. Returns count. */
export async function backfillEmbeddings(batchSize = 32): Promise<number> {
  if (!isVecEnabled()) return 0;
  const pending = db
    .prepare("SELECT rowid, id, key, value FROM memories WHERE embedded_at IS NULL")
    .all() as Array<{ rowid: number; id: string; key: string; value: string }>;
  let done = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vecs = await embedMany(batch.map((r) => `${r.key}\n${r.value}`));
    if (!vecs) break;
    const tx = db.transaction(() => {
      batch.forEach((r, j) => {
        upsertVector(r.rowid, vecs[j]);
        db.prepare("UPDATE memories SET embedded_at = datetime('now') WHERE id = ?").run(r.id);
      });
    });
    tx();
    done += batch.length;
    log.info("embedding backfill progress", { done, total: pending.length });
  }
  return done;
}

/** Semantic KNN search within a set of projects. Returns memory ids + distance. */
export async function searchVector(
  query: string,
  projects: string[],
  limit = 20
): Promise<Array<{ id: string; distance: number }>> {
  if (!isVecEnabled()) return [];
  const vec = await embedOne(query);
  if (!vec) return [];
  const placeholders = projects.map(() => "?").join(",");
  // KNN over vec table, join back to memories to scope by project.
  const rows = db
    .prepare(
      `SELECT m.id AS id, v.distance AS distance
       FROM vec_memories v
       JOIN memories m ON m.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
         AND m.project IN (${placeholders})
         AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
       ORDER BY v.distance`
    )
    .all(vec, limit * 3, ...projects) as Array<{ id: string; distance: number }>;
  return rows.slice(0, limit);
}

/** Remove a memory's vector (call on forget/delete). */
export function deleteVector(rowid: number): void {
  if (!isVecEnabled()) return;
  try { db.prepare("DELETE FROM vec_memories WHERE rowid = ?").run(BigInt(rowid)); } catch { /* ignore */ }
}
