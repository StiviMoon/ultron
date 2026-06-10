// ── ULTRON v9 — search enrichment (related suggestions + knowledge gaps) ───────
// Local graph-based enrichment — no external LLM API required.

import type { MemoryRow } from "../db/types.js";
import { neighborhood } from "./graph.service.js";

export interface RelatedSuggestion {
  key: string;
  relation: "manual" | "semantic" | string;
  via: string;
}

export function enrichSearchResults(
  project: string,
  query: string,
  memories: MemoryRow[]
): { related_suggestions: RelatedSuggestion[]; knowledge_gaps: string[] } {
  const resultKeys = new Set(memories.map((m) => m.key));
  const related: RelatedSuggestion[] = [];

  for (const m of memories.slice(0, 3)) {
    try {
      const nb = neighborhood(project, m.key, 1);
      for (const edge of nb.edges) {
        const other = edge.from === m.key ? edge.to : edge.from;
        if (other === "_snapshot" || resultKeys.has(other)) continue;
        related.push({ key: other, relation: edge.relation, via: m.key });
      }
    } catch { /* graph may be empty */ }
  }

  const seen = new Set<string>();
  const related_suggestions = related
    .filter((r) => {
      if (seen.has(r.key)) return false;
      seen.add(r.key);
      return true;
    })
    .slice(0, 5);

  const knowledge_gaps: string[] = [];
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 2);

  if (memories.length === 0) {
    knowledge_gaps.push(
      `No memories match "${query}" — consider remember(project, key, value, "warning"|"pattern") to document this`
    );
  } else if (memories.length < 3 && terms.length >= 3) {
    knowledge_gaps.push(
      `Sparse coverage for a detailed query — review if "${query}" needs a dedicated memory`
    );
  }

  if (related_suggestions.length > 0 && memories.length > 0) {
    const unlinked = related_suggestions.filter((r) => r.relation === "semantic");
    if (unlinked.length >= 2) {
      knowledge_gaps.push(
        `Multiple semantically related keys not in results — consider linking with related=[] or compress()`
      );
    }
  }

  return { related_suggestions, knowledge_gaps };
}
