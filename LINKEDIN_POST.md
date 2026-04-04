# Post LinkedIn — ULTRON Hub

---

Construí una herramienta que le da memoria persistente a Claude Code. Se llama **ULTRON Hub**.

El problema que resuelve: cada vez que abrís Claude Code, la IA no sabe nada sobre tu proyecto. Tenés que explicar el stack, el contexto, los bugs anteriores, las decisiones técnicas. De nuevo. Cada sesión.

ULTRON termina con eso.

---

**¿Qué hace?**

- Guarda conocimiento del proyecto en una base de datos SQLite local (sin cuentas, sin cloud, sin API keys)
- Al iniciar una sesión, la IA recibe automáticamente: última sesión, tareas pendientes, warnings críticos, decisiones técnicas
- Al cerrar, guarda un snapshot comprimido del estado del proyecto para la próxima vez
- Funciona en Claude Code, Cursor, y cualquier herramienta compatible con MCP

---

**Un día real usando ULTRON:**

Abro Claude Code a las 9am:
```
session_start("mi-proyecto", "claude-code")
```
La IA ya sabe: "ayer implementaste el formulario de pago, falta el webhook de Stripe, y tenés 3 tareas pendientes".

Durante el trabajo, cada aprendizaje se guarda:
```
remember("proyecto", "stripe-warning",
  "Siempre enviar idempotency key — sin esto los webhooks duplican cobros",
  "warning")

task("proyecto", "add", "agregar retry logic", tags=["queue"])
```

Al cerrar:
```
session_end("proyecto", "claude-code", "implementé webhook receiver", ["src/webhooks/stripe.ts"])
```

Mañana, la IA arranca exactamente desde donde dejé.

---

**Lo que tiene:**

- 18 herramientas MCP: sesiones, memoria, tareas con tags, decisiones, búsqueda full-text (FTS5), generación de reglas CLAUDE.md, export/import entre máquinas
- Grafo de conocimiento: las memorias se vinculan entre sí con `related`
- Auto-limpieza: `clean` detecta y elimina memorias no consultadas en 45+ días
- Token efficiency: modo slim, filtros por sección, snapshot automático
- Todo local: un archivo `.db` en `~/.ultron/`

---

**¿Por qué importa?**

Cuando una IA trabaja con contexto acumulado durante semanas en lugar de empezar de cero cada vez, la calidad del trabajo cambia completamente. Los warnings anteriores evitan repetir errores. Las decisiones técnicas evitan debates ya cerrados. El backlog persiste entre herramientas.

ULTRON convierte sesiones de IA desconectadas en un flujo de trabajo continuo.

---

**Instalación (3 comandos):**

```bash
git clone https://github.com/StiviMoon/ultron
cd ultron
npm install && npm run build
```

Luego agregar en `~/.mcp.json`:
```json
{
  "mcpServers": {
    "ultron": {
      "command": "node",
      "args": ["/ruta/a/ultron/dist/index.js"]
    }
  }
}
```

Open source, MIT. Requiere Node.js 18+.

Repo: github.com/StiviMoon/ultron

---

#ClaudeCode #DeveloperTools #AI #MCP #OpenSource #Productivity #SoftwareDevelopment
