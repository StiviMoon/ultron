// ── ULTRON v8 — Reciprocal Rank Fusion ────────────────────────────────────────
// Merges multiple ranked id lists into one score map. Higher score = better.

export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}
