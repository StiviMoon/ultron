// ── ULTRON v8 — token estimation ─────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token for English/Spanish mixed text */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}
