# AGENTS.md — ULTRON Hub v9

> **You are an AI agent with access to ULTRON via MCP.**  
> Read this file first. It tells you exactly what to do in 60 seconds.

ULTRON is **persistent memory between sessions**. It stores project knowledge, tasks, and decisions in local SQLite. Your user expects you to **use it proactively** — not wait to be asked.

**Fastest path:** call MCP tool `onboard()` — returns the full protocol as JSON.  
**This file:** deeper patterns for power usage.

---

## 60-second start

```
1. session_start("<project>", "<your-tool>", slim=true)
2. Read rules + warnings BEFORE touching code
3. Work → remember() discoveries, task() backlog, decision() choices
4. session_end("<project>", "<your-tool>", summary, [files])
```

Replace `<project>` with the repo/project name (e.g. `ultron`, `my-api`).  
Replace `<your-tool>` with `cursor`, `claude-code`, or your client name.

**Every ULTRON response may include `next_actions`** — follow them.

---

## What ULTRON is (and is not)

| ULTRON IS | ULTRON IS NOT |
|-----------|---------------|
| Long-term memory across sessions | A chat history dump |
| Warnings about past mistakes | A task runner |
| Technical decision log | A file indexer |
| Persistent backlog | A replacement for reading code |

**Golden rule:** save what you'd hate re-discovering tomorrow. Skip what you'd find in 10 seconds of reading the code.

---

## Mandatory session protocol

### Start (always)

```json
session_start("my-project", "cursor", slim=true)
```

Returns (priority order):
1. **rules** — non-negotiable, read first
2. **warnings** — past mistakes, read before related code
3. **pending_tasks** — backlog sorted by priority
4. **recent_decisions** — why the code is the way it is
5. **_snapshot** — compressed state from last session

**Token savers:**
- `slim=true` → memory keys only (~80% fewer tokens)
- `fields=["tasks","decisions"]` → load subset only
- `diff_since="2026-06-01T00:00:00Z"` → only changes since date

### During work

| You discovered… | Call |
|-----------------|------|
| A bug cause, gotcha, constraint | `remember(..., category="warning")` |
| An architecture pattern that works | `remember(..., category="pattern")` |
| Stack fact (URL, version, env var) | `remember(..., category="fact")` |
| Chose tech A over tech B | `decision(topic, choice, reason)` |
| New work item | `task(action="add", ...)` |
| Need existing knowledge | `search(query, mode="hybrid")` **before** creating duplicates |

### End (never skip)

```json
session_end("my-project", "cursor", "Implemented X, Y pending", ["src/x.ts"])
```

Refreshes `_snapshot`. Next `session_start` loads instantly.

---

## Decision tree — which tool?

```
Need project context?
├─ Start of session → session_start
├─ Mid-session, no new session → recall
└─ First time using ULTRON → onboard

Need to find something?
├─ Know the topic vaguely → search(mode="hybrid")
├─ Only tasks → search(scope=["tasks"])
└─ Cross-project → search(projects=["all"])

Need to save something?
├─ Important, named key → remember
├─ Quick throwaway thought → note
├─ Irreversible choice → decision
└─ Work item → task(action="add")

Need to clean up?
├─ Outdated memory → forget
├─ Many stale memories → clean(action="list") then archive
├─ Overlapping keys → compress
└─ Project health check → health

Need rules for the codebase?
└─ generate_rules(format="cursor") → paste into .cursor/rules

Handing off to another agent?
└─ agent_handoff(from_agent, to_agent, context)
```

---

## Memory categories — pick the right one

| Category | When | Loaded |
|----------|------|--------|
| `rule` | Non-negotiable project law | **Always first** |
| `warning` | Real mistake to never repeat | High priority |
| `pattern` | Proven architecture/code pattern | High priority |
| `preference` | Style, conventions | Medium |
| `fact` | Stack, URLs, versions | On recall/search |
| `note` | Quick observation | Low |

**Importance 1–10** (auto-set by category). Raise for critical items.

### Key naming

```
<topic>-<specifics>     ✅  auth-jwt-expiry, api-response-format
random text             ❌  "thing about auth"
duplicate prefixes      ⚠️  search first; use compress if 4+ under same prefix
```

---

## Power patterns

### 1. Search before remember

Always `search("project", "topic")` before `remember`. ULTRON warns on similar keys — listen to warnings.

### 2. Link related knowledge

```json
remember("proj", "payment-flow", "...", "pattern", related=["stripe-webhook", "idempotency-key"])
```

Then `graph("proj", "payment-flow")` reveals the neighborhood.

### 3. Priority-aware tasks

`task list` sorts by priority (high → medium → low).  
`task done` with position `"1"` marks the **highest priority** pending task — not oldest.

### 4. Decision chains

When reversing a decision:
```json
decision("proj", "cache", "Redis", "Need TTL", supersedes="<old-decision-id>")
```

### 5. Subagent handoff

```json
agent_register("my-auditor", type="subagent")
agent_log("my-auditor", "audit-done", project="proj", detail="score 71")
agent_handoff("proj", from_agent="my-auditor", to_agent="implementer", context="Fix P0 first: ...")
```

Receiving agent: `search("proj", "handoff-implementer")`.

### 6. Token budget before heavy recall

```json
token_budget("proj")   → if >8000 tokens, use slim + clean stale
health("proj")         → actionable issues
```

### 7. MCP Resources (read without tool calls)

| URI | Content |
|-----|---------|
| `ultron://agent-guide` | **This guide** (AGENTS.md) |
| `ultron://examples/session-workflow` | 3-session Stripe example |
| `ultron://projects` | All projects + stats |
| `ultron://{project}/context` | Slim context |
| `ultron://{project}/rules` | Rules + warnings |

### 7b. Search enrichment (v9)

`search()` returns extra fields when searching memories:
- `related_suggestions` — graph neighbors of top hits (keys you might also need)
- `knowledge_gaps` — hints when coverage is thin (consider `remember()`)

### 8. MCP Prompts (guided workflows)

- `start-session` — open work session
- `end-session` — close with summary
- `audit-memory` — health + cleanup workflow

---

## Anti-patterns — do NOT

| Don't | Why |
|-------|-----|
| Save file contents / debug logs | Transient; bloats memory |
| Skip `session_end` | Snapshot stale; next session loses context |
| Create duplicate keys | search + update existing instead |
| Ignore `warnings` on session_start | They exist because prod broke before |
| `remember` 10k-char essays | Save `.md` file; remember the path |
| Assume task position = creation order | Positions follow **priority** |
| Call `recall` at session start | Use `session_start` (also opens session) |

---

## Token optimization cheat sheet

| Situation | Do |
|-----------|-----|
| Default session | `session_start(..., slim=true)` |
| Only need tasks | `recall(..., fields=["tasks"])` |
| Check cost | `token_budget(project)` |
| Too many memories | `clean(action="list")` → `archive` |
| Overlapping keys | `compress(keys=[...], new_key=...)` |
| Export rules to IDE | `generate_rules(format="cursor")` |

---

## All 25 MCP tools (reference)

| Group | Tools |
|-------|-------|
| **Session** | `onboard`, `session_start`, `session_end`, `projects`, `handoff` |
| **Memory** | `recall`, `remember`, `note`, `forget`, `search` |
| **Work** | `task`, `decision`, `list_decisions` |
| **Intelligence** | `health`, `metrics`, `graph`, `compress`, `generate_rules`, `token_budget` |
| **Sync** | `export_project`, `import_project` |
| **Agents** | `agent_register`, `agent_log`, `agent_handoff` |

---

## Exploring this repo (ultron itself)

ULTRON's source is an MCP server, not a web app:

```
src/index.ts          → MCP boot (tools + resources + prompts)
src/tools/*.ts        → 25 tool definitions (Zod + defineTool)
src/services/*.ts     → Business logic
src/repositories/*.ts → SQL only layer
src/db/               → Schema + migrations
src/daemon/           → Background maintenance
```

**Architecture:** `tools → services → repositories → SQLite`  
**Data:** `~/.ultron/ultron.db` (local, private)  
**Tests:** `npm test` (18 tests)  
**Build:** `npm run build` → `dist/index.js`

When contributing to ULTRON: read `ARCHITECTURE.md` for design decisions.

---

## Checklist per session

- [ ] `session_start(project, tool, slim=true)`
- [ ] Read all `rules` and `warnings`
- [ ] Confirm `pending_tasks` with user if unclear
- [ ] `search` before `remember` (avoid duplicates)
- [ ] `decision` when choosing between alternatives
- [ ] `task done` as items complete
- [ ] `session_end` with summary + files touched

---

## One-liner for any model

> **Start with `session_start`, read warnings first, `search` before `remember`, `session_end` always.**

---

_ULTRON Hub v9 — [github.com/StiviMoon/ultron](https://github.com/StiviMoon/ultron)_
