// ── ULTRON v9 — search enrichment tests ───────────────────────────────────────

import { describe, it, expect } from "vitest";
import { enrichSearchResults } from "../services/search-enrichment.service.js";
import type { MemoryRow } from "../db/types.js";

const base = (key: string): MemoryRow => ({
  id: key, project: "p", key, value: "v", category: "fact", tool: null, agent: null,
  expires_at: null, last_accessed_at: null, access_count: 0, importance: 5,
  related: "[]", embedded_at: null, created_at: "", updated_at: "",
});

describe("enrichSearchResults", () => {
  it("suggests knowledge_gap when no results", () => {
    const r = enrichSearchResults("p", "stripe webhook idempotency", []);
    expect(r.knowledge_gaps.length).toBeGreaterThan(0);
    expect(r.related_suggestions).toHaveLength(0);
  });

  it("suggests sparse coverage for detailed queries with few hits", () => {
    const r = enrichSearchResults("p", "how to handle race conditions in payments", [base("a")]);
    expect(r.knowledge_gaps.some((g) => g.includes("Sparse"))).toBe(true);
  });
});
