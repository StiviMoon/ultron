# ULTRON Hub v9

> The best persistent memory for AI agents. Your assistant never forgets.

Local SQLite memory for **Claude Code**, **Cursor**, and any MCP-compatible tool.  
Hybrid keyword + semantic search. Zero cloud. Zero API keys.

[![CI](https://github.com/StiviMoon/ultron/actions/workflows/ci.yml/badge.svg)](https://github.com/StiviMoon/ultron/actions/workflows/ci.yml)

---

## Quick start

```bash
# Option A: clone + build
git clone https://github.com/StiviMoon/ultron
cd ultron && npm install && npm run build
node dist/index.js init    # autoconfig MCP for Claude Code + Cursor

# Option B: npm (after publish)
npx ultron-hub init
```

Restart your IDE. First call: `onboard()` or `session_start("my-project", "cursor")`.

**AI agents:** read [AGENTS.md](AGENTS.md) — instant protocol for models exploring or using ULTRON.

---

## The 3-step workflow

**1. Start every session:**
```
session_start("my-project", "cursor", slim=true)
```

**2. Save knowledge as you go:**
```
remember("my-project", "auth-gotcha", "JWT expires in 5m in dev", "warning")
decision("my-project", "database", "PostgreSQL", "better Prisma support")
task("my-project", "add", "implement Stripe webhook", tags=["payments"])
```

**3. Close the session:**
```
session_end("my-project", "cursor", "finished PaymentForm", ["src/PaymentForm.tsx"])
```

Every response includes `next_actions` — the agent always knows what to do next.

---

## All 25 tools

### Memory (5)
| Tool | Purpose |
|------|---------|
| `recall` | Load project context manually |
| `remember` | Save persistent knowledge + auto-embed |
| `note` | Quick thought with auto key |
| `forget` | Delete memory (+ vector + graph links) |
| `search` | Hybrid keyword+semantic search |

### Session (5)
| Tool | Purpose |
|------|---------|
| `session_start` | Start session + load full context |
| `session_end` | Close session + refresh snapshot |
| `projects` | List all projects with stats |
| `handoff` | Markdown block for web chats |
| `onboard` | Full ULTRON protocol in one call |

### Work (3)
| Tool | Purpose |
|------|---------|
| `task` | Backlog: add, update, done, list, delete |
| `decision` | Log immutable technical decision |
| `list_decisions` | Decision history with supersedes chain |

### Intelligence (6)
| Tool | Purpose |
|------|---------|
| `health` | Project integrity diagnostics |
| `metrics` | Usage + semantic coverage |
| `graph` | Knowledge graph neighborhood |
| `compress` | Merge overlapping memories |
| `generate_rules` | Export rules (claude/cursor/agents format) |
| `token_budget` | Token cost estimate + suggestions |

### Sync (2)
| Tool | Purpose |
|------|---------|
| `export_project` | Full JSON export (links, agents, runs) |
| `import_project` | Import with auto re-embed |

### Agents (3)
| Tool | Purpose |
|------|---------|
| `agent_register` | Register subagent/daemon |
| `agent_log` | Audit agent runs |
| `agent_handoff` | Pass context between agents |

### MCP Resources (3)
| URI | Content |
|-----|---------|
| `ultron://projects` | All projects with stats |
| `ultron://{project}/context` | Slim project context |
| `ultron://{project}/rules` | Rules and warnings |

### MCP Prompts (3)
`start-session` · `end-session` · `audit-memory`

---

## Memory categories

| Category | Use |
|----------|-----|
| `rule` | Non-negotiable — always injected first |
| `warning` | Things to avoid — learned from mistakes |
| `pattern` | Architecture patterns to follow |
| `preference` | Team style and conventions |
| `fact` | Stack, URLs, versions |
| `note` | Free-form observations |

---

## Token efficiency

```
session_start("project", "cursor", slim=true)     # ~80% fewer tokens
recall("project", fields=["tasks"])                # load subset only
token_budget("project")                            # check cost
clean("project", action="archive")                 # remove stale
```

---

## Daemon (background maintenance)

```bash
ultron-daemon --once          # run all maintenance once
ultron-daemon                 # loop every 6h
ultron-daemon --once --dry    # preview without changes
```

Tasks: purge expired, decay importance, backfill embeddings, incremental graph links, rotating DB backups.

---

## Connect to Claude Code / Cursor

```json
{
  "mcpServers": {
    "ultron": {
      "command": "node",
      "args": ["/absolute/path/to/ultron/dist/index.js"]
    }
  }
}
```

Or run `node dist/index.js init` to configure automatically.

---

## Data

All data in `~/.ultron/ultron.db`. Backups in `~/.ultron/backups/`.

```bash
ULTRON_DB_PATH=/custom/path.db node dist/index.js
cp ~/.ultron/ultron.db ~/backups/ultron-$(date +%Y%m%d).db
```

---

## Requirements

- Node.js >= 18
- C++ build tools (for `better-sqlite3`)
- No external services, accounts, or API keys

---

## License

MIT — [github.com/StiviMoon/ultron](https://github.com/StiviMoon/ultron)
