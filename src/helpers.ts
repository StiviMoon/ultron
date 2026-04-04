// ── ULTRON Hub v5 — Helpers ──────────────────────────────────────────────────

type McpResult = { content: Array<{ type: "text"; text: string }> };

/** JSON response for structured data */
export function ok(data: unknown): McpResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Plain text response */
export function text(content: string): McpResult {
  return { content: [{ type: "text", text: content }] };
}

/** Error response as JSON */
export function err(message: string): McpResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

/** Extract error message and log to stderr */
export function errOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[ULTRON]", msg);
  return msg;
}

/** ISO 8601 timestamp */
export function now(): string {
  return new Date().toISOString();
}

/** Truncate string with ellipsis indicator */
export function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** Rough token estimate: ~4 chars per token for English/Spanish mixed text */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}
