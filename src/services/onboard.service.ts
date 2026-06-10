// ── ULTRON v9 — onboard protocol for any AI agent ─────────────────────────────

export function getOnboardProtocol(): Record<string, unknown> {
  return {
    ultron_version: "9.0.0",
    tagline: "Persistent developer memory — local SQLite, zero cloud, works with any MCP client",
    workflow: {
      step1: {
        action: "session_start",
        when: "At the START of every work session",
        example: 'session_start("my-project", "cursor", slim=true)',
        returns: "Last session, rules, warnings, pending tasks, decisions, snapshot",
      },
      step2: {
        action: "remember / task / decision / search",
        when: "DURING work — save non-obvious knowledge as you discover it",
        examples: [
          'remember("my-project", "auth-gotcha", "JWT expires in 5m in dev", "warning")',
          'decision("my-project", "database", "PostgreSQL", "better Prisma support")',
          'task("my-project", "add", "implement webhook retry", tags=["payments"])',
          'search("my-project", "stripe", mode="hybrid")',
        ],
      },
      step3: {
        action: "session_end",
        when: "At the END of every work session",
        example: 'session_end("my-project", "cursor", "finished PaymentForm", ["src/PaymentForm.tsx"])',
        returns: "Closes session + refreshes _snapshot for next session_start",
      },
    },
    categories: {
      rule: "Non-negotiable — always injected first on session_start",
      warning: "Things to AVOID — learned from real mistakes",
      pattern: "Architecture/code patterns to FOLLOW",
      preference: "Team style and conventions",
      fact: "Stack, URLs, versions, env var names",
      note: "Free-form observations",
    },
    key_conventions: [
      "Use kebab-case keys with topic prefix: auth-jwt-expiry, api-response-format",
      "Prefer updating an existing key over creating duplicates",
      "Long values (>600 chars): save as .md file, remember the path instead",
      "Use slim:true on session_start to save ~80% tokens on memories",
      "Use fields:[\"tasks\"] to load only what you need",
      "Warnings and rules are highest priority — read them before coding",
    ],
    anti_patterns: [
      "Do NOT save transient info (current file contents, debug output)",
      "Do NOT duplicate keys — search first, then update",
      "Do NOT skip session_end — snapshot won't refresh",
      "Do NOT use positional task IDs without checking list order (priority-sorted)",
    ],
    tools_count: 25,
    tools_by_group: {
      memory: ["recall", "remember", "note", "forget", "search"],
      session: ["session_start", "session_end", "projects", "handoff", "onboard"],
      work: ["task", "decision", "list_decisions"],
      intelligence: ["health", "metrics", "graph", "compress", "generate_rules", "token_budget"],
      sync: ["export_project", "import_project"],
      agents: ["agent_register", "agent_log", "agent_handoff"],
    },
    token_tips: [
      "session_start(slim=true) — keys only, no values",
      "recall(fields=[\"tasks\"]) — load subset",
      "token_budget(project) — check cost before full recall",
      "clean(project, action='list') — find stale memories to archive",
    ],
    agent_docs: "Full guide for AI agents: AGENTS.md in repo root (or read this onboard() response)",
    checklist: [
      "session_start(project, tool, slim=true)",
      "Read rules + warnings before coding",
      "search before remember (avoid duplicates)",
      "decision when choosing between alternatives",
      "session_end with summary + files",
    ],
  };
}
