# ULTRON Hub v9 — Guía de uso

> El sistema de memoria persistente para Claude Code, Cursor y cualquier cliente MCP.
> Tu IA no olvida nada entre sesiones. 25 tools + resources + prompts.

**Agentes de IA:** lee [AGENTS.md](AGENTS.md) — protocolo instantáneo para cualquier modelo.

---

## Un día real con ULTRON

Así se ve trabajar con ULTRON desde que abres Claude Code hasta que lo cerrás.

### 9:00 AM — Empezás el día

```
session_start("mi-proyecto", "claude-code")
```

ULTRON responde con:
- **Última sesión:** "implementé el formulario de pago, falta el webhook"
- **Tareas pendientes:** [high] integrar Stripe webhook | [medium] tests de integración
- **Warnings activos:** "no mockear la BD en tests — prod falló por esto"
- **Snapshot:** resumen comprimido del estado del proyecto

La IA ya sabe dónde quedaste. Sin repetir contexto.

### Durante el trabajo

Cada vez que aprendés algo nuevo:

```
# Encontraste un bug importante
remember("mi-proyecto", "stripe-idempotency",
  "Siempre enviar idempotency key en Stripe — sin esto los webhooks duplican cobros",
  "warning")

# Definiste un patrón de arquitectura
remember("mi-proyecto", "webhook-pattern",
  "Todos los webhooks van a /api/webhooks/:provider — validan firma → enqueue job → 200",
  "pattern",
  related=["stripe-idempotency", "queue-config"])

# Nueva tarea descubierta
task("mi-proyecto", "add", "agregar retry logic al job processor", tags=["queue", "resilience"])

# Decisión técnica tomada
decision("mi-proyecto", "queue", "BullMQ + Redis",
  "pg-boss descartado por falta de retry exponential nativo. BullMQ tiene mejor DX.")
```

### 1:00 PM — Necesitás buscar algo

```
search("mi-proyecto", "stripe")
→ Encuentra: stripe-idempotency, webhook-pattern, decisión de BullMQ

search("mi-proyecto", "auth", scope=["memories", "decisions"])
→ Busca en memorias Y decisiones al mismo tiempo
```

### 6:00 PM — Cerrás la sesión

```
session_end("mi-proyecto", "claude-code",
  "implementé webhook receiver + job processor con retry, falta el test e2e",
  ["src/api/webhooks/stripe.ts", "src/jobs/processPayment.ts"])
```

ULTRON automáticamente:
1. Guarda el resumen
2. Crea un `_snapshot` con el estado actual del proyecto
3. La próxima sesión empieza con ese snapshot cargado

---

## Instalación

```bash
# Clonar y buildear
git clone https://github.com/StiviMoon/ultron
cd ultron
npm install
npm run build

# Configurar en Claude Code (~/.mcp.json o .mcp.json del proyecto)
{
  "mcpServers": {
    "ultron": {
      "command": "node",
      "args": ["/ruta/absoluta/ultron/dist/index.js"]
    }
  }
}
```

Los datos se guardan en `~/.ultron/ultron.db` — se crea automáticamente al primer uso.

---

## El protocolo de trabajo

### Al ABRIR una sesión

```
session_start("mi-proyecto", "claude-code")
```

Devuelve todo lo que necesitás para retomar: warnings primero, luego tareas ordenadas por prioridad, decisiones recientes, y el snapshot de la última sesión.

### Durante el trabajo

Guardá conocimiento a medida que aparece. No esperes al final.

```
remember("proyecto", "key", "valor", "categoria")
remember("proyecto", "key", "valor", "pattern", related=["key1", "key2"])
decision("proyecto", "tema", "elección", "por qué")
task("proyecto", "add", "algo que hacer", tags=["area"])
note("proyecto", "observación rápida")
```

### Al CERRAR la sesión

```
session_end("proyecto", "claude-code", "qué hiciste", ["archivos tocados"])
```

---

## Las 5 categorías de memoria

Elegir la correcta hace que `generate_rules` funcione mejor.

| Categoría | Cuándo usar | Ejemplo |
|---|---|---|
| `fact` | Datos concretos del proyecto | Stack, URLs, versiones |
| `pattern` | Cómo se hace algo aquí | Arquitectura de módulos, convenciones |
| `preference` | Cómo preferís trabajar | Estilo de código, herramientas elegidas |
| `warning` | Qué evitar — aprendiste de un error | "No mockear la BD en tests de integración" |
| `note` | Observación rápida | Idea que surgió, algo a revisar después |

Las más valiosas son `warning` y `pattern` — cargan primero en `session_start` y se convierten en reglas CLAUDE.md con `generate_rules`.

---

## Los 25 tools — cuándo usar cada uno

> Cada respuesta incluye `next_actions` — el agente siempre sabe qué hacer después.
> Primera vez: llamá `onboard()` para aprender el protocolo completo.

### Sesión

| Tool | Cuándo |
|---|---|
| `onboard` | Primera vez con ULTRON, o si no sabés qué tool usar |
| `session_start` | Siempre al abrir un proyecto |
| `session_end` | Siempre al cerrar, con un buen resumen |
| `projects` | Ver todos los proyectos y sus stats |
| `handoff` | Llevar contexto a Claude.ai / ChatGPT sin MCP |

### Memoria

| Tool | Cuándo |
|---|---|
| `remember` | Cuando aprendés algo que no querés explicar de vuelta |
| `note` | Pensamiento rápido, sin elegir key |
| `forget` | Memoria desactualizada (limpia vector + grafo) |
| `recall` | Cargar contexto mid-session (session_start ya lo hace al inicio) |
| `search` | Buscar antes de crear duplicados (modo hybrid por defecto) |
| `clean` | Limpiar memorias sin acceso en 45+ días |

### Tareas y decisiones

| Tool | Cuándo |
|---|---|
| `task add/done/list` | Backlog persistente entre sesiones |
| `decision` | Elegir tecnología, patrón o enfoque (inmutable) |
| `list_decisions` | Historial con cadena `supersedes` |

### Inteligencia

| Tool | Cuándo |
|---|---|
| `health` | Antes de sesiones largas o si recall se siente lento |
| `metrics` | Cobertura semántica y memorias más usadas |
| `graph` | Explorar conocimiento relacionado |
| `compress` | Fusionar memorias con prefijo duplicado |
| `generate_rules` | Exportar reglas (format: claude, cursor, agents) |
| `token_budget` | Estimar costo de tokens del recall |

### Sync y agentes

| Tool | Cuándo |
|---|---|
| `export_project` | Backup completo (links, agents, runs) |
| `import_project` | Restaurar en otra máquina (re-embed automático) |
| `agent_register/log/handoff` | Ecosistema de subagentes |

---

## Grafo de conocimiento con `related`

Las memorias pueden estar vinculadas entre sí. Esto ayuda a navegar conceptos relacionados.

```
remember("proyecto", "auth-flow",
  "Login → JWT → refresh token cada 15min",
  "pattern",
  related=["jwt-config", "refresh-token-warning"])

remember("proyecto", "refresh-token-warning",
  "Nunca guardar el refresh token en localStorage — usar httpOnly cookie",
  "warning",
  related=["auth-flow"])
```

Cuando `recall` devuelve `auth-flow`, también muestra las keys relacionadas — podés pedirlas con `search` si necesitás los valores.

---

## Tags en tareas

```
task("proyecto", "add", "migrar schema de pagos", tags=["db", "payments", "migration"])
task("proyecto", "add", "actualizar endpoints de Stripe", tags=["payments", "api"])
task("proyecto", "add", "escribir tests e2e de auth", tags=["auth", "testing"])

# Ver solo las de payments:
task("proyecto", "list", filter_tag="payments")
→ migrar schema de pagos
→ actualizar endpoints de Stripe
```

---

## Snapshot automático

Cada `session_end` guarda un `_snapshot` con el estado del proyecto:

```
_snapshot: Last session (claude-code): implementé webhook receiver — Files: src/webhooks/stripe.ts
           Pending tasks: [high] test e2e | [medium] retry logic | [low] documentar API
           Key knowledge: stripe-idempotency, webhook-pattern, queue-config, auth-flow
```

La próxima vez que abras el proyecto, este snapshot es lo primero que carga. No necesitás leer 30 memorias para saber dónde estás.

---

## Optimización de tokens

```
# Solo keys, sin valores — ahorra ~80% tokens en memories
session_start("proyecto", "claude-code", slim=true)

# Solo cargar lo que necesitás
recall("proyecto", fields=["tasks"])
recall("proyecto", fields=["memories", "decisions"])

# Verificar cuánto pesa el proyecto
token_budget("proyecto")
→ Muestra breakdown por sección + cantidad de memorias stale

# Limpiar memorias no consultadas en 45+ días
clean("proyecto")                      # ver qué hay
clean("proyecto", action="archive")    # borrar todas
clean("proyecto", action="delete", key="old-key")  # borrar una
```

### Regla práctica
- Proyectos nuevos o pequeños: `session_start` normal
- Proyectos grandes (>20 memories): `session_start(slim=true)` + `search` para valores específicos
- Proyectos muy viejos: `clean` primero, luego `session_start`

---

## Generar reglas CLAUDE.md

```
generate_rules("proyecto")
```

Convierte todas las memories `warning`, `pattern` y `preference` en reglas para tu CLAUDE.md.

**Flujo recomendado:**
1. Durante semanas, guardás warnings y patterns mientras trabajás
2. Cada tanto corrés `generate_rules`
3. Pegás el resultado en `CLAUDE.md` del proyecto
4. La próxima sesión, la IA tiene esas reglas sin consumir tokens de memoria

---

## Sync entre máquinas

```
# Máquina A — exportar
export_project("mi-proyecto")

# Máquina B — importar
import_project('[el json]', "merge")
# merge = conserva lo más reciente
# replace = sobreescribe todo
```

---

## Búsqueda avanzada

```
# Buscar en memories (FTS5 — full-text, rápido y relevante)
search("proyecto", "stripe webhook")

# Buscar en decisiones y tareas también
search("proyecto", "auth", scope=["memories", "decisions", "tasks"])

# Buscar en TODOS los proyectos
search("cualquiera", "prisma", projects=["all"])

# Buscar en proyectos específicos
search("mj", "payment", projects=["mj", "vendly"])
```

---

## Decisiones bien guardadas

Una buena decisión tiene contexto suficiente para entenderse en 6 meses:

```
decision(
  "proyecto",
  "base-de-datos",
  "PostgreSQL + Prisma",
  "SQLite descartado por falta de soporte multiusuario. MongoDB descartado por schema flexible innecesario. PostgreSQL tiene el mejor soporte de Prisma y tipo DATE nativo."
)
```

---

## Tareas — posiciones vs UUIDs

```
# Una tarea a la vez (seguro):
task("proyecto", "done", id="1")   # posición 1

# Múltiples en paralelo (usar UUID):
task("proyecto", "done", id="b87d-...")
task("proyecto", "done", id="fc1d-...")
# No uses posiciones en paralelo — pueden shiftear
```

---

## Archivo de datos

```
~/.ultron/ultron.db   ← SQLite, un solo archivo

# Custom location:
ULTRON_DB_PATH=/otro/path/ultron.db node dist/index.js

# Backup:
cp ~/.ultron/ultron.db ~/backups/ultron-$(date +%Y%m%d).db
```

---

*ULTRON Hub v9 — https://github.com/StiviMoon/ultron*
