# ULTRON Hub — Guía de uso

> El sistema de memoria persistente para Claude Code y Cursor.
> Tu IA no olvida nada entre sesiones.

---

## Instalación

```bash
# Desde GitHub
npm install -g github:StiviMoon/ultron

# Configurar en Claude Code (~/.mcp.json o .mcp.json del proyecto)
{
  "mcpServers": {
    "ultron": {
      "command": "node",
      "args": ["/ruta/a/ultron/dist/index.js"]
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

Devuelve todo lo que necesitás saber para retomar: última sesión, tareas pendientes, decisiones técnicas, y el conocimiento acumulado del proyecto.

### Durante el trabajo

Guardá conocimiento a medida que aparece. No esperes al final.

```
remember("proyecto", "key", "valor", "categoria")
decision("proyecto", "tema", "elección", "por qué")
task("proyecto", "add", "algo que hacer")
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
| `fact` | Datos concretos del proyecto | Stack, URLs, versiones, credenciales (nunca secrets) |
| `pattern` | Cómo se hace algo aquí | Arquitectura de módulos, convenciones de nombres |
| `preference` | Cómo preferís trabajar | Estilo de código, herramientas elegidas |
| `warning` | Qué evitar — aprendiste de un error | "No mockear la BD en tests de integración" |
| `note` | Observación rápida | Idea que surgió, algo a revisar después |

Las más valiosas son `warning` y `pattern` — son las que se convierten en reglas CLAUDE.md.

---

## Los 16 tools — cuándo usar cada uno

### Sesión

| Tool | Cuándo |
|---|---|
| `session_start` | Siempre al abrir un proyecto |
| `session_end` | Siempre al cerrar, con un buen resumen |

### Memoria

| Tool | Cuándo |
|---|---|
| `remember` | Cuando aprendés algo sobre el proyecto que no querés explicar de vuelta |
| `note` | Pensamiento rápido, no hace falta estructurarlo |
| `forget` | Cuando una memoria quedó desactualizada |
| `recall` | Para cargar contexto manualmente (session_start ya lo hace) |

### Búsqueda

| Tool | Cuándo |
|---|---|
| `search` | Cuando sabés que hay algo guardado pero no recordás la key |

### Tareas

| Tool | Cuándo |
|---|---|
| `task add` | Al descubrir algo que falta hacer |
| `task done` | Al completar — usar posición (1, 2, 3) es más fácil que el UUID |
| `task list` | Para ver todo el backlog |

### Decisiones

| Tool | Cuándo |
|---|---|
| `decision` | Al elegir una tecnología, patrón, o enfoque sobre otros |
| `list_decisions` | Para revisar el historial de decisiones |

### Inteligencia

| Tool | Cuándo |
|---|---|
| `generate_rules` | Cuando querés actualizar el CLAUDE.md del proyecto con lo aprendido |
| `token_budget` | Si el recall empieza a sentirse pesado — para diagnosticar |
| `handoff` | Para llevar contexto a Claude.ai o ChatGPT sin MCP |

### Sync

| Tool | Cuándo |
|---|---|
| `export_project` | Backup o para mover datos a otra máquina |
| `import_project` | Restaurar desde export |

---

## Optimización de tokens

ULTRON puede consumir muchos tokens si el proyecto creció mucho. Usá estos controles:

```
# Solo keys, sin valores — ahorra ~80% tokens en memories
session_start("proyecto", "claude-code", slim=true)

# Solo cargar lo que necesitás
recall("proyecto", fields=["tasks"])          # solo tareas
recall("proyecto", fields=["memories"])       # solo conocimiento
recall("proyecto", fields=["tasks", "decisions"])

# Verificar cuánto pesa el proyecto
token_budget("proyecto")
→ Muestra breakdown por sección + sugerencias si es demasiado
```

### Regla práctica
- Proyectos nuevos o con pocas memories: `session_start` sin parámetros
- Proyectos grandes (>20 memories): `session_start(slim=true)` y cargás los valores que necesitás con `search` o `recall`

---

## Generar reglas CLAUDE.md

Esta es la feature más poderosa: tu experiencia acumulada se convierte en reglas de trabajo.

```
generate_rules("proyecto")
```

Toma todas las memories de tipo `warning`, `pattern` y `preference` y las formatea como reglas para pegar en el CLAUDE.md del proyecto.

**Flujo recomendado:**
1. Durante semanas, guardás warnings y patterns mientras trabajás
2. Cada tanto corrés `generate_rules`
3. Pegás el resultado en `CLAUDE.md` del proyecto
4. La próxima sesión, la IA ya tiene esas reglas sin consumir tokens de memoria

---

## Sync entre máquinas

```
# Máquina A — exportar
export_project("mi-proyecto")
# Copiás el JSON que devuelve

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

# Buscar también en decisiones y tareas
search("proyecto", "auth", scope=["memories", "decisions", "tasks"])

# Buscar en TODOS los proyectos
search("cualquiera", "prisma", projects=["all"])

# Buscar en proyectos específicos
search("mj", "payment", projects=["mj", "vendly"])
```

---

## Claves para decisions bien guardadas

Una buena decisión tiene contexto suficiente para entenderse en 6 meses:

```
decision(
  "proyecto",
  "base-de-datos",          # tema: corto y searchable
  "PostgreSQL + Prisma",    # qué elegiste
  "SQLite descartado por falta de soporte multiusuario. MongoDB descartado por schema flexible innecesario. PostgreSQL tiene el mejor soporte de Prisma y tipo DATE nativo para las queries de reportes."
)
```

---

## Tareas — posiciones vs UUIDs

Las posiciones son dinámicas (cambian cuando marcás una tarea como done). Los UUIDs son estáticos.

```
# Correcto para una tarea a la vez:
task("proyecto", "done", id="1")   # posición 1

# Correcto para múltiples en paralelo:
task("proyecto", "done", id="b87d...")  # UUID
task("proyecto", "done", id="fc1d...")  # UUID
# ⚠️ No uses posiciones en paralelo — pueden shiftear
```

---

## Archivo de datos

```
~/.ultron/ultron.db   ← SQLite, un solo archivo

# Custom location:
ULTRON_DB_PATH=/otro/path/ultron.db

# Backup:
cp ~/.ultron/ultron.db ~/backups/ultron-$(date +%Y%m%d).db
```

---

## Proyectos disponibles

```
projects()
→ Lista todos los proyectos con:
   - última sesión (herramienta + resumen)
   - tareas pendientes
   - cantidad de memories y decisiones
```

---

*ULTRON Hub v5 — https://github.com/StiviMoon/ultron*
