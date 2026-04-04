# ULTRON Hub — Arquitectura del sistema

Genera un diagrama de arquitectura visual, moderno y limpio que represente el siguiente sistema. Usá el estilo de diagramas técnicos profesionales (como los de Excalidraw o Mermaid, pero renderizado como imagen clara).

---

## Descripción del sistema

**ULTRON Hub** es un servidor MCP (Model Context Protocol) que actúa como capa de memoria persistente entre herramientas de IA (Claude Code, Cursor) y una base de datos SQLite local.

---

## Componentes principales

### 1. Herramientas de IA (clientes MCP)
- **Claude Code** — CLI de Anthropic para desarrollo asistido por IA
- **Cursor** — IDE con IA integrada
- Cualquier cliente compatible con MCP
- Se conectan a ULTRON via **stdio** (protocolo estándar MCP)

### 2. ULTRON Hub (servidor MCP — Node.js)
Es el núcleo del sistema. Corre como proceso local. Expone **18 herramientas MCP**.

Módulos internos:
- **`src/index.ts`** — Servidor MCP con los 18 tools
- **`src/db.ts`** — Conexión SQLite + schema auto-init + migraciones
- **`src/helpers.ts`** — Funciones puras: ok(), err(), truncate(), estimateTokens()

### 3. Base de datos SQLite local
Archivo único en `~/.ultron/ultron.db`

4 tablas principales:
- **`memories`** — conocimiento persistente clave-valor por proyecto. Columnas clave: `project`, `key`, `value`, `category` (fact/pattern/warning/preference/note), `related` (JSON array de keys vinculadas), `last_accessed_at`, `expires_at`
- **`tasks`** — backlog persistente por proyecto. Columnas clave: `project`, `text`, `status` (pending/done), `priority` (high/medium/low), `tags` (JSON array)
- **`decisions`** — decisiones técnicas inmutables. Columnas: `project`, `topic`, `choice`, `reason`
- **`sessions`** — historial de sesiones por herramienta. Columnas: `project`, `tool`, `summary`, `files` (JSON), `started_at`, `ended_at`

Características técnicas de la BD:
- **FTS5** — búsqueda full-text en memories (tabla virtual `memories_fts` + 3 triggers de sync)
- **WAL mode** — Write-Ahead Logging para concurrencia
- **Schema auto-init** — CREATE TABLE IF NOT EXISTS en cada arranque
- **Migraciones automáticas** — ALTER TABLE para upgrades sin romper datos existentes

---

## Flujo de datos (session workflow)

```
1. Developer abre Claude Code / Cursor
2. La IA llama → session_start("proyecto", "claude-code")
3. ULTRON consulta SQLite → devuelve: warnings primero, tareas por prioridad, snapshot, decisiones
4. Durante el trabajo:
   - remember() → INSERT/UPSERT en memories
   - task() → INSERT/UPDATE en tasks
   - decision() → INSERT en decisions (inmutable)
   - search() → FTS5 MATCH en memories_fts
5. Al cerrar: session_end() → UPDATE sessions + auto-genera _snapshot en memories
6. Próxima sesión: el _snapshot comprimido carga en milisegundos
```

---

## Los 18 tools agrupados por función

**Memoria (7):**
`session_start` · `recall` · `remember` · `note` · `forget` · `search` · `clean`

**Tareas y decisiones (3):**
`task` · `decision` · `list_decisions`

**Sesiones y proyectos (3):**
`session_end` · `projects` · `handoff`

**Inteligencia (2):**
`generate_rules` · `token_budget`

**Sync (2):**
`export_project` · `import_project`

---

## Diagrama a generar

Crear un diagrama que muestre claramente:

1. **Capa superior** — Las herramientas de IA (Claude Code, Cursor, "Other MCP client") conectadas por flechas al servidor ULTRON con la etiqueta "MCP / stdio"

2. **Capa media** — ULTRON Hub como caja central con:
   - Los 18 tools agrupados visualmente en sus 5 categorías
   - Las 3 capas internas: index.ts (tools), db.ts (SQLite layer), helpers.ts (utils)

3. **Capa inferior** — La base de datos SQLite con las 4 tablas (memories, tasks, decisions, sessions) y las features especiales (FTS5, WAL, auto-snapshot, related graph)

4. **Flecha lateral** — `generate_rules` → `CLAUDE.md` del proyecto (output de inteligencia)

5. **Flecha lateral** — `handoff` → Claude.ai / ChatGPT (para cuando no hay MCP)

6. **Flujo de sesión** — Una línea de tiempo o secuencia que muestre: session_start → work → session_end → _snapshot → next session_start

**Estilo sugerido:**
- Fondo oscuro (#0d1117 o similar) o blanco limpio
- Colores por categoría de tool: rojo para warnings/clean, verde para memoria, azul para sesiones, naranja para inteligencia
- Íconos simples: base de datos para SQLite, cerebro o chip para ULTRON, terminal para Claude Code
- Fuente monospace para nombres de tools y tablas
- Flechas con etiquetas en los flujos principales

---

## Datos adicionales para el diagrama

- El archivo de datos es UN solo archivo: `~/.ultron/ultron.db`
- No hay servidor externo, no hay red, todo es local
- El proceso ULTRON Hub corre como daemon silencioso en segundo plano
- Múltiples herramientas (Claude Code + Cursor) pueden leer la misma BD simultáneamente gracias a WAL
- La columna `related` en memories forma un grafo de conocimiento navegable
- El `_snapshot` es una memory especial que se sobreescribe en cada session_end

---

*ULTRON Hub v6 — github.com/StiviMoon/ultron*
