# ULTRON Hub

> Your AI assistant forgets everything between sessions. ULTRON fixes that.

Persistent developer memory for **Claude Code**, **Cursor**, and any MCP-compatible tool. Local SQLite database, zero config, one command to install.

```bash
npm install -g github:stevenvo780/ultron-hub
```

## The Problem

Every time you open Claude Code or Cursor, your AI starts from zero. You re-explain your stack, your decisions, where you left off. Every session costs tokens rebuilding context that already existed.

ULTRON gives your AI a brain that persists across sessions and tools.

## How It Works

```
~/.ultron/ultron.db ← Local SQLite (auto-created on first run)
        │
        ├── Claude Code (MCP)
        ├── Cursor (MCP)
        └── Claude.ai / ChatGPT (via handoff)
```

All tools read and write to the same local brain. When you switch tools, your context is already there.

## Quick Start

### 1. Install

```bash
npm install -g github:stevenvo780/ultron-hub
```

### 2. Connect to Claude Code

Add to your global config (`~/.claude/settings.json`) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "ultron": {
      "command": "ultron-hub"
    }
  }
}
```

### 3. Connect to Cursor

Go to **Settings > MCP** and add:

```json
{
  "mcpServers": {
    "ultron": {
      "command": "ultron-hub"
    }
  }
}
```

### 4. Use it

Restart your tool. ULTRON's 16 tools are now available.

## Tools

### Memory & Context

| Tool | What it does |
|---|---|
| `recall` | Load full project context (sessions, memories, tasks, decisions) |
| `remember` | Save persistent key-value knowledge with categories |
| `note` | Quick thought with auto-generated key |
| `forget` | Delete a specific memory |
| `search` | Full-text search across memories, decisions, tasks (FTS5) |

### Tasks & Decisions

| Tool | What it does |
|---|---|
| `task` | Manage backlog: add, update, done, delete, list |
| `decision` | Log an immutable technical decision |
| `list_decisions` | Full decision history with pagination |

### Sessions

| Tool | What it does |
|---|---|
| `session_start` | Start a work session + auto-load context |
| `session_end` | Close session with summary of what was done |
| `projects` | List all projects with stats |

### Intelligence

| Tool | What it does |
|---|---|
| `generate_rules` | Convert your warnings/patterns into CLAUDE.md rules |
| `token_budget` | Estimate token cost per project, get optimization tips |
| `handoff` | Generate markdown context for Claude.ai or ChatGPT |

### Sync

| Tool | What it does |
|---|---|
| `export_project` | Export project data as JSON |
| `import_project` | Import JSON data (merge or replace) |

## Typical Workflow

**Starting a session:**
```
session_start("my-project", "claude-code")
→ Last session: implemented PaymentForm.tsx
  Pending: Stripe webhook
  Decision: Stripe Elements over Culqi
```

**During work:**
```
remember("my-project", "api-pattern", "All endpoints return { success, data?, error? }", "pattern")
decision("my-project", "payments", "Stripe", "has official TypeScript SDK")
task("my-project", "add", "implement /api/stripe webhook")
```

**Closing:**
```
session_end("my-project", "claude-code", "finished form validation, webhook pending", ["src/PaymentForm.tsx"])
```

**Switching to Claude.ai:**
```
handoff("my-project")
→ Markdown block ready to paste
```

## Memory Categories

| Category | Use |
|---|---|
| `fact` | Concrete project data: stack, URLs, versions |
| `pattern` | Code or architecture patterns to follow |
| `preference` | Team conventions, style rules |
| `warning` | Things to avoid, known bugs, gotchas |
| `note` | Free-form observations |

## Token Efficiency

ULTRON is designed to minimize token waste:

- **Slim mode**: `recall(project, slim=true)` returns only keys — saves ~80% tokens
- **Field filter**: Load only what you need: `fields=["tasks"]`
- **Value truncation**: Long memories are auto-truncated in recall (configurable)
- **Token budget**: `token_budget(project)` shows exactly what each section costs
- **Stale detection**: Memories not accessed in 45+ days are flagged for cleanup
- **Generate rules**: Turn your experience into CLAUDE.md rules for permanent, zero-token-cost guidance

## Data Location

All data lives in `~/.ultron/ultron.db`. To customize:

```bash
ULTRON_DB_PATH=/custom/path/ultron.db ultron-hub
```

Backup is trivial — it's a single file.

## Sync Between Machines

```
# Machine A
export_project("my-project") → save the JSON

# Machine B
import_project(json, "merge") → data merged into local DB
```

## Generate CLAUDE.md Rules

ULTRON learns from your work. The `generate_rules` tool converts your stored warnings and patterns into CLAUDE.md rules:

```
generate_rules("my-project")
→ # Project Rules: my-project
  ## Avoid
  - Never mock the database in integration tests
  - Positional task IDs shift in parallel calls — use UUIDs
  ## Follow
  - All API responses use { success, data?, error? }
  - Controllers delegate to services, never access DB directly
```

Paste this into your project's `CLAUDE.md` for permanent, zero-cost guidance.

## Requirements

- Node.js >= 18
- No external services, accounts, or API keys needed

## License

MIT

---

Built by [Steven Villarreal](https://github.com/stevenvo780). PRs, issues, and contributions welcome.
