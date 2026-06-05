// ── ULTRON v8 — RRF fusion tests ──────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { rrf } from "../lib/rrf.js";

describe("rrf", () => {
  it("ranks an item appearing high in both lists first", () => {
    const keyword = ["a", "b", "c"];
    const semantic = ["a", "d", "b"];
    const scores = rrf([keyword, semantic]);
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked[0]).toBe("a"); // top of both
    expect(ranked.indexOf("b")).toBeLessThan(ranked.indexOf("c")); // b in both beats c in one
  });

  it("includes items unique to one list", () => {
    const scores = rrf([["a"], ["b"]]);
    expect(scores.has("a")).toBe(true);
    expect(scores.has("b")).toBe(true);
  });

  it("higher rank (lower index) yields higher score", () => {
    const scores = rrf([["first", "second"]]);
    expect(scores.get("first")!).toBeGreaterThan(scores.get("second")!);
  });

  it("empty input yields empty map", () => {
    expect(rrf([]).size).toBe(0);
  });
});
