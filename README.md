# ULTRON Hub

> Your AI assistant forgets everything between sessions. ULTRON fixes that.

Persistent developer memory for **Claude Code**, **Cursor**, and any MCP-compatible tool.  
Local SQLite — no accounts, no API keys, no cloud.

---

## Install

```bash
git clone https://github.com/StiviMoon/ultron
cd ultron
npm install
npm run build
```

> **Requires Node.js >= 18** and a C++ compiler (for `better-sqlite3`).  
> On Ubuntu/Debian: `sudo apt install build-essential`  
> On macOS: Xcode Command Line Tools (`xcode-select --install`)

---

## Connect to Claude Code

Add to `~/.mcp.json` (global) or your project's `.mcp.json`:

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

Replace `/absolute/path/to/ultron` with the actual path where you cloned the repo.  
Example: `/home/youruser/tools/ultron/dist/index.js`

Restart Claude Code. You'll see `✓ ultron: ultron-hub v6.0.0 — Connected`.

## Connect to Cursor

Go to **Settings → MCP** and add:

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

---

## How It Works

```
~/.ultron/ultron.db   ← SQLite, auto-created on first run
         │
         ├── Claude Code (MCP)
         ├── Cursor (MCP)
         └── Claude.ai / ChatGPT (via handoff tool)
```

All tools share the same local database. Switch tools mid-session — your context is already there.

---

## The 3-step workflow

**1. Start every session:**
```
session_start("my-project", "claude-code")
```
Returns last session summary, pending tasks, knowledge base, and recent decisions.  
Warnings and critical patterns load first. Ready to work in one call.

**2. Save knowledge as you go:**
```
remember("my-project", "api-pattern", "All endpoints return { success, data?, error? }", "pattern")
remember("my-project", "stripe-flow", "...", "pattern", related=["payment-hook", "webhook-handler"])
decision("my-project", "database", "PostgreSQL", "better Prisma support than MySQL")
task("my-project", "add", "implement Stripe webhook", tags=["payments", "urgent"])
note("my-project", "check Stripe rate limits in test mode")
```

**3. Close the session:**
```
session_end("my-project", "claude-code", "finished PaymentForm, webhook pending", ["src/PaymentForm.tsx"])
```
Automatically saves a `_snapshot` memory — compressed project state for fast future recall.

---

## All 18 Tools

### Memory

| Tool | What it does |
|---|---|
| `session_start` | Start session + auto-load full context (warnings first) |
| `recall` | Load project context manually (slim mode, field filter) |
| `remember` | Save persistent key-value knowledge + optional `related` links |
| `note` | Quick thought with auto-generated key |
| `forget` | Delete a memory by key |
| `search` | Full-text search (FTS5) across memories, decisions, tasks |
| `clean` | List/archive stale memories (not accessed in 45+ days) |

### Tasks & Decisions

| Tool | What it does |
|---|---|
| `task` | Backlog management: `add`, `update`, `done`, `delete`, `list` + tags + filter_tag |
| `decision` | Log an immutable technical decision |
| `list_decisions` | Full decision history with pagination |

### Sessions & Projects

| Tool | What it does |
|---|---|
| `session_end` | Close session with summary + auto-snapshot |
| `projects` | List all projects with stats (tasks, memories, decisions) |
| `handoff` | Generate markdown context block for Claude.ai / ChatGPT |

### Intelligence

| Tool | What it does |
|---|---|
| `generate_rules` | Convert stored warnings/patterns into CLAUDE.md rules |
| `token_budget` | Estimate token cost per project + stale memory count |

### Sync

| Tool | What it does |
|---|---|
| `export_project` | Export all project data as JSON |
| `import_project` | Import JSON with `merge` or `replace` strategy |

---

## Memory Categories

| Category | Use |
|---|---|
| `fact` | Stack, URLs, versions, env var names |
| `pattern` | Architecture patterns, code conventions to follow |
| `preference` | Team style, tools chosen, personal workflow |
| `warning` | Things to avoid — known bugs, gotchas, past mistakes |
| `note` | Free-form observations and quick thoughts |

`warning` and `pattern` are the most valuable — they load first on `session_start` and become CLAUDE.md rules via `generate_rules`.

---

## Token Efficiency

```
# Slim mode: keys only, no values — saves ~80% tokens on memories
session_start("project", "claude-code", slim=true)

# Load only what you need
recall("project", fields=["tasks"])
recall("project", fields=["memories", "decisions"])

# Check token cost + stale memory count
token_budget("project")

# Clean up stale memories (not accessed in 45+ days)
clean("project")                      # list them
clean("project", action="archive")    # delete all stale
```

---

## Linked Knowledge Graph

```
# Link related memories together
remember("my-project", "payment-flow", "...", "pattern",
  related=["stripe-webhook", "idempotency-key"])

# When you recall payment-flow, you see its related keys
# → navigate the knowledge graph with search()
```

---

## Task Tags

```
# Add tasks with tags
task("my-project", "add", "fix auth redirect", tags=["auth", "bug"])
task("my-project", "add", "add Stripe webhook", tags=["payments"])

# Filter tasks by tag
task("my-project", "list", filter_tag="auth")
# → shows only tasks tagged "auth"
```

---

## Auto-Snapshot

Every `session_end` automatically saves a `_snapshot` memory — a compressed summary of:
- What was done this session
- Files touched
- Pending tasks (top 5)
- Most recently used memory keys

This makes the next `session_start` faster: even with `slim=true`, the snapshot gives full project orientation in one line.

---

## Generate CLAUDE.md Rules

```
generate_rules("my-project")
```

Reads all `warning` and `pattern` memories and outputs ready-to-paste CLAUDE.md rules:

```markdown
# Project Rules: my-project

## Avoid
- Never mock the database in integration tests — mocked tests passed but prod migration failed
- Don't use positional task IDs in parallel calls — positions shift when tasks complete

## Follow
- All API responses use { success, data?, error? } — never return raw data
- Controllers never access the DB directly — always go through services
```

Paste into your project's `CLAUDE.md` for permanent, zero-token guidance.

---

## Sync Between Machines

```
# Machine A — export
export_project("my-project")
# → Copy the JSON from the response

# Machine B — import
import_project('<json>', "merge")
# merge = keep newer data  |  replace = overwrite everything
```

---

## Updating

```bash
cd ultron
git pull
npm run build
```

Restart Claude Code / Cursor after updating.

---

## Data

All data lives in `~/.ultron/ultron.db` — a single SQLite file.

```bash
# Custom location
ULTRON_DB_PATH=/custom/path/ultron.db node dist/index.js

# Backup
cp ~/.ultron/ultron.db ~/backups/ultron-$(date +%Y%m%d).db
```

---

## Requirements

- Node.js >= 18
- C++ build tools (`build-essential` on Linux, Xcode CLI on macOS)
- No external services, accounts, or API keys

---

## License

MIT — [github.com/StiviMoon/ultron](https://github.com/StiviMoon/ultron)
