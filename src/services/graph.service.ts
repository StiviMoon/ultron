// ── ULTRON v8 — knowledge graph service ───────────────────────────────────────
// Edges live in memory_links, derived from memories.related (manual) and from
// embedding similarity (semantic). Provides BFS neighborhood traversal.

import { db } from "../db/connection.js";
import * as memoryRepo from "../repositories/memory.repo.js";
import { searchVector } from "../repositories/vector.repo.js";
import { isVecEnabled } from "../db/connection.js";
import { log } from "../lib/logger.js";

/** Rebuild manual edges for a project from each memory's `related` key list. */
export function rebuildManualLinks(project: string): number {
  const memories = db
    .prepare("SELECT id, key, related FROM memories WHERE project = ?")
    .all(project) as Array<{ id: string; key: string; related: string }>;
  const keyToId = new Map(memories.map((m) => [m.key, m.id]));

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_links WHERE relation = 'manual' AND from_id IN (SELECT id FROM memories WHERE project = ?)").run(project);
    let n = 0;
    for (const m of memories) {
      let keys: string[] = [];
      try { keys = JSON.parse(m.related || "[]"); } catch { keys = []; }
      for (const k of keys) {
        const toId = keyToId.get(k);
        if (!toId || toId === m.id) continue;
        db.prepare(
          "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight) VALUES (?, ?, 'manual', 1.0)"
        ).run(m.id, toId);
        n++;
      }
    }
    return n;
  });
  return tx();
}

/** Suggest semantic edges: for each memory, link nearest neighbors above threshold. */
export async function rebuildSemanticLinks(project: string, threshold = 0.55, perNode = 3): Promise<number> {
  if (!isVecEnabled()) return 0;
  const memories = db
    .prepare("SELECT id, key, value FROM memories WHERE project = ? AND key != '_snapshot'")
    .all(project) as Array<{ id: string; key: string; value: string }>;
  let n = 0;
  db.prepare("DELETE FROM memory_links WHERE relation = 'semantic' AND from_id IN (SELECT id FROM memories WHERE project = ?)").run(project);
  for (const m of memories) {
    const neighbors = await searchVector(`${m.key}\n${m.value}`, [project], perNode + 1);
    for (const nb of neighbors) {
      if (nb.id === m.id) continue;
      // sqlite-vec returns L2 distance for normalized vectors; convert to ~similarity.
      const sim = 1 - nb.distance / 2;
      if (sim < threshold) continue;
      db.prepare(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight) VALUES (?, ?, 'semantic', ?)"
      ).run(m.id, nb.id, sim);
      n++;
    }
  }
  log.info("semantic links rebuilt", { project, edges: n });
  return n;
}

/** Incremental semantic link rebuild — only memories updated since last gardener run. */
export async function rebuildSemanticLinksIncremental(
  project: string, since: string | null, threshold = 0.55, perNode = 3
): Promise<number> {
  if (!isVecEnabled()) return 0;
  const sql = since
    ? "SELECT id, key, value FROM memories WHERE project = ? AND key != '_snapshot' AND updated_at > ?"
    : "SELECT id, key, value FROM memories WHERE project = ? AND key != '_snapshot'";
  const memories = (since
    ? db.prepare(sql).all(project, since)
    : db.prepare(sql).all(project)) as Array<{ id: string; key: string; value: string }>;

  if (memories.length === 0) return 0;

  let n = 0;
  for (const m of memories) {
    db.prepare("DELETE FROM memory_links WHERE relation = 'semantic' AND from_id = ?").run(m.id);
    const neighbors = await searchVector(`${m.key}\n${m.value}`, [project], perNode + 1);
    for (const nb of neighbors) {
      if (nb.id === m.id) continue;
      const sim = 1 - nb.distance / 2;
      if (sim < threshold) continue;
      db.prepare(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight) VALUES (?, ?, 'semantic', ?)"
      ).run(m.id, nb.id, sim);
      n++;
    }
  }
  if (n > 0) log.info("semantic links incremental", { project, edges: n, memories: memories.length });
  return n;
}

/** BFS neighborhood around a memory key, up to `depth` hops. */
export function neighborhood(project: string, key: string, depth = 1): {
  root: string;
  nodes: Array<{ key: string; category: string; value: string }>;
  edges: Array<{ from: string; to: string; relation: string; weight: number }>;
} {
  const root = memoryRepo.getByKey(project, key);
  if (!root) return { root: key, nodes: [], edges: [] };

  const visited = new Set<string>([root.id]);
  let frontier = [root.id];
  const edges: Array<{ from: string; to: string; relation: string; weight: number }> = [];

  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const links = db
        .prepare("SELECT from_id, to_id, relation, weight FROM memory_links WHERE from_id = ? OR to_id = ?")
        .all(id, id) as Array<{ from_id: string; to_id: string; relation: string; weight: number }>;
      for (const l of links) {
        const other = l.from_id === id ? l.to_id : l.from_id;
        edges.push({ from: l.from_id, to: l.to_id, relation: l.relation, weight: l.weight });
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const ids = Array.from(visited);
  const rows = memoryRepo.getByIds(ids);
  const idToKey = new Map(rows.map((r) => [r.id, r.key]));
  return {
    root: root.key,
    nodes: rows.map((r) => ({ key: r.key, category: r.category, value: r.value })),
    edges: edges
      .map((e) => ({ from: idToKey.get(e.from) ?? e.from, to: idToKey.get(e.to) ?? e.to, relation: e.relation, weight: e.weight }))
      .filter((e, i, arr) => arr.findIndex((x) => x.from === e.from && x.to === e.to && x.relation === e.relation) === i),
  };
}
