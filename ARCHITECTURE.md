# ULTRON Hub v9 — Architecture

## Overview

ULTRON Hub is a local MCP (Model Context Protocol) server that provides persistent developer memory for AI agents. All data lives in `~/.ultron/ultron.db` — no cloud, no API keys.

```
Claude Code / Cursor / any MCP client
         │ stdio MCP
         ▼
┌─────────────────────────────────────────┐
│  ULTRON Hub (Node.js)                   │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │ Tools   │ │ Resources│ │ Prompts │  │
│  │ (25)    │ │ (3)      │ │ (3)     │  │
│  └────┬────┘ └────┬─────┘ └────┬────┘  │
│       └───────────┼────────────┘        │
│                   ▼                     │
│            Services layer               │
│     recall · health · graph · embed     │
│                   ▼                     │
│           Repositories layer            │
│     memory · task · session · sync      │
│                   ▼                     │
│         SQLite + FTS5 + sqlite-vec      │
└─────────────────────────────────────────┘
         ▲                    ▲
         │ WAL (shared)       │
┌────────┴──────┐    ┌───────┴────────┐
│ ultron-daemon │    │ ~/.ultron/     │
│ curator       │    │ backups/       │
│ gardener      │    │ models/        │
│ backup        │    │                │
└───────────────┘    └────────────────┘
```

## Layer responsibilities

| Layer | Path | Role |
|-------|------|------|
| Boot | `src/index.ts` | MCP server init, warmup, `init` CLI |
| Tools | `src/tools/*` | MCP tool definitions (Zod + defineTool) |
| Resources | `src/resources/registry.ts` | Navigable context without tool calls |
| Prompts | `src/prompts/registry.ts` | Guided workflows for agents |
| Services | `src/services/*` | Business logic (recall, health, graph, rules) |
| Repositories | `src/repositories/*` | **Only place with SQL** |
| DB | `src/db/*` | Schema, connection, versioned migrations |

## Database schema

| Table | Purpose |
|-------|---------|
| `memories` | Key-value knowledge per project (categories, importance, embeddings) |
| `tasks` | Persistent backlog with priority and tags |
| `decisions` | Immutable technical decisions (chainable via `supersedes`) |
| `sessions` | Session history per tool |
| `memory_links` | Knowledge graph edges (manual + semantic, FK CASCADE) |
| `agents` | Agent registry |
| `agent_runs` | Agent audit log |
| `vec_memories` | sqlite-vec embedding table (rowid = memories.rowid) |
| `memories_fts` | FTS5 virtual table for keyword search |
| `_meta` | Schema version and daemon state |

## Search pipeline

```
query → FTS5 keyword search ──┐
                               ├── RRF fusion → ranked results
query → embed → KNN search ───┘
```

Degrades to keyword-only if sqlite-vec is unavailable.

## Session workflow

1. `session_start(project, tool)` — purge expired, open session, load context
2. Work — `remember`, `task`, `decision`, `search`
3. `session_end(project, tool, summary, files)` — close session, refresh `_snapshot`

## Data integrity rules

- **All memory deletes** go through `memoryRepo.deleteMemories()` — cleans vectors + links
- **All memory upserts** set `embedded_at = NULL` → triggers re-embed
- **Migrations** are versioned in `_meta.schema_version` (currently v10)

## Daemon tasks

| Task | Interval | Action |
|------|----------|--------|
| nightly-curator | 6h | Purge expired, decay importance, WAL checkpoint |
| memory-gardener | 6h | Backfill embeddings, incremental semantic links |
| backup | 6h | `VACUUM INTO` rotating backup (keep 7) |

## MCP surface

- **25 tools** — memory, session, work, intelligence, sync, agents, onboard
- **3 resources** — projects list, project context, project rules
- **3 prompts** — start-session, end-session, audit-memory

## Key design decisions

1. **Local-first** — privacy, zero config, works offline
2. **Repository pattern** — zero SQL in tools (enforced in v9)
3. **Agent ergonomics** — descriptions, examples, `next_actions`, `onboard`
4. **Graceful degradation** — keyword-only if vectors fail
5. **Separate daemon** — background work off stdio MCP process
