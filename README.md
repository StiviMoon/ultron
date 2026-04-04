# ULTRON Hub

> Your AI assistant forgets everything between sessions. ULTRON fixes that.

Persistent developer memory for **Claude Code**, **Cursor**, and any MCP-compatible tool.  
Local SQLite — no accounts, no API keys, no cloud.

---

## Install

```bash
npm install -g github:StiviMoon/ultron
```

> Requires Node.js >= 18 and a C++ compiler (for `better-sqlite3`).  
> On Ubuntu/Debian: `sudo apt install build-essential`  
> On macOS: Xcode Command Line Tools (`xcode-select --install`)

---

## Connect to Claude Code

Add to `~/.mcp.json` (global) or your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ultron": {
      "command": "ultron-hub"
    }
  }
}
```

Restart Claude Code. You'll see `✓ ultron: ultron-hub v5.0.0 — Connected`.

## Connect to Cursor

Go to **Settings → MCP** and add:

```json
{
  "mcpServers": {
    "ultron": {
      "command": "ultron-hub"
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
Returns last session summary, pending tasks, knowledge base, and recent decisions. Ready to work in one call.

**2. Save knowledge as you go:**
```
remember("my-project", "api-pattern", "All endpoints return { success, data?, error? }", "pattern")
decision("my-project", "database", "PostgreSQL", "better Prisma support than MySQL")
task("my-project", "add", "implement Stripe webhook")
note("my-project", "check Stripe rate limits in test mode")
```

**3. Close the session:**
```
session_end("my-project", "claude-code", "finished PaymentForm, webhook pending", ["src/PaymentForm.tsx"])
```

---

## All 16 Tools

### Memory

| Tool | What it does |
|---|---|
| `session_start` | Start session + auto-load full project context |
| `recall` | Load project context manually (slim mode, field filter) |
| `remember` | Save persistent key-value knowledge |
| `note` | Quick thought with auto-generated key |
| `forget` | Delete a memory by key |
| `search` | Full-text search (FTS5) across memories, decisions, tasks |

### Tasks & Decisions

| Tool | What it does |
|---|---|
| `task` | Backlog management: `add`, `update`, `done`, `delete`, `list` |
| `decision` | Log an immutable technical decision |
| `list_decisions` | Full decision history with pagination |

### Sessions & Projects

| Tool | What it does |
|---|---|
| `session_end` | Close session with summary and files touched |
| `projects` | List all projects with stats (tasks, memories, decisions) |
| `handoff` | Generate markdown context block for Claude.ai / ChatGPT |

### Intelligence

| Tool | What it does |
|---|---|
| `generate_rules` | Convert stored warnings/patterns into CLAUDE.md rules |
| `token_budget` | Estimate token cost per project + optimization suggestions |

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

`warning` and `pattern` are the most valuable — they become CLAUDE.md rules via `generate_rules`.

---

## Token Efficiency

```
# Slim mode: keys only, no values — saves ~80% tokens on memories
session_start("project", "claude-code", slim=true)

# Load only what you need
recall("project", fields=["tasks"])
recall("project", fields=["memories", "decisions"])

# Check token cost before it becomes a problem
token_budget("project")
```

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
- Don't use positional task IDs in parallel calls — positions shift when tasks are completed

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

## Data

All data lives in `~/.ultron/ultron.db` — a single SQLite file.

```bash
# Custom location
ULTRON_DB_PATH=/custom/path/ultron.db ultron-hub

# Backup
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
