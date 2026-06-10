// ── ULTRON v9 — next_actions helpers for agent guidance ───────────────────────

export function withActions<T extends Record<string, unknown>>(
  data: T,
  actions: string[]
): T & { next_actions: string[] } {
  return actions.length > 0 ? { ...data, next_actions: actions } : data;
}

export function sessionStartActions(ctx: {
  rules?: unknown[];
  pending_tasks?: unknown[];
  memories?: Array<{ category: string }>;
}): string[] {
  const actions: string[] = [];
  const warnings = (ctx.memories ?? []).filter((m) => m.category === "warning").length;
  if ((ctx.rules?.length ?? 0) > 0) actions.push("Read rules first — they override defaults");
  if (warnings > 0) actions.push(`${warnings} warning(s) loaded — check before changing related code`);
  if ((ctx.pending_tasks?.length ?? 0) > 0) actions.push("Review pending_tasks and confirm priority with user");
  actions.push("Call session_end with summary + files when done");
  return actions;
}

export function rememberActions(warnings: string[], similarCount: number): string[] {
  const actions: string[] = [];
  if (similarCount > 0) actions.push("Similar keys exist — update existing key instead of duplicating");
  if (warnings.some((w) => w.includes("Long value"))) actions.push("Consider saving long content as a .md file and referencing the path");
  actions.push("Use search() to verify this knowledge is retrievable");
  return actions;
}

export function taskDoneActions(highPending: number): string[] {
  const actions: string[] = [];
  if (highPending > 0) actions.push(`${highPending} high-priority task(s) remaining`);
  else actions.push("No high-priority tasks left — check medium/low backlog");
  return actions;
}

export function healthActions(score: number, issueCount: number): string[] {
  if (score >= 80) return ["Project memory is healthy — continue working"];
  if (issueCount > 0) return ["Address health issues before adding more memories", "Run clean(project, action='list') for stale entries"];
  return ["Run token_budget(project) to optimize recall cost"];
}
