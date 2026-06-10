# Changelog

## v9.0.0 — 2026-06-10

### Critical fixes
- **Centralized memory deletion** — all delete paths now clean `vec_memories` and `memory_links` in a transaction
- **Task position bug** — `resolveId` now uses priority order matching `list`
- **Re-embed on upsert** — `session_end`, `agent_handoff`, and `compress` always re-embed

### Architecture
- SQL moved from tools to repositories (`agent.repo`, `project.repo`, `sync.repo`)
- `defineTool` wrapper with centralized error logging
- Split tools: `maintenance`, `intelligence`, `sync`, `onboard`
- MCP Resources (`ultron://projects`, `ultron://{project}/context`, `ultron://{project}/rules`)
- MCP Prompts (`start-session`, `end-session`, `audit-memory`)

### Agent ergonomics
- **25 tools** with when-to-use descriptions and examples
- `next_actions` in tool responses — agents always know what to do next
- **`onboard` tool** — full protocol in one call for any model
- **`generate_rules` multi-format** — claude | cursor | agents
- Decisions support `supersedes` chain

### Quality
- Integration test suite (18 tests total)
- GitHub Actions CI (Node 18/20/22)
- Schema v10: FK CASCADE on `memory_links`, `supersedes` on decisions

### Distribution
- `ultron-hub init` — autoconfig MCP for Claude Code + Cursor
- Full export/import (links, agents, agent_runs) + auto re-embed
- Daemon: rotating backups via `VACUUM INTO`, importance decay, incremental semantic links

## v8.0.0
- Hybrid FTS5 + sqlite-vec search with RRF
- Local embeddings (MiniLM-L6-v2)
- Knowledge graph, health/metrics, agent ecosystem
- Daemon for background maintenance

## v6.0.0
- 18 core MCP tools
- FTS5 search, task tags, linked knowledge graph
- Export/import, generate_rules, token_budget
