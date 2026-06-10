# ULTRON — Real-world workflow example

Three sessions integrating Stripe payments. Uses **v9 tools only** (no external APIs).

---

## Session 1 — Monday

### Start
```
session_start("stripe-project", "cursor", slim=true)
```

Read `rules` and `warnings` first. Note `pending_tasks`.

### During work
```
remember("stripe-project", "payment-form-state",
  "Form holds: cardElement, amount. Never send cardElement to backend", "pattern")

remember("stripe-project", "webhook-signature-secret",
  "STRIPE_WEBHOOK_SECRET in env. Verify signature before processing", "warning",
  related=["webhook-processing"])

task("stripe-project", "add", "Implement webhook receiver", priority="high", tags=["payments"])

decision("stripe-project", "idempotency", "nanoid keys in DB table",
  "Stripe retries webhooks — must dedupe by idempotency key")
```

### Search before duplicating
```
search("stripe-project", "idempotent payment", mode="hybrid")
```

v9 returns `related_suggestions` (graph neighbors) and `knowledge_gaps` if coverage is thin.

### End
```
session_end("stripe-project", "cursor",
  "Completed PaymentForm with validation",
  ["src/PaymentForm.tsx", "src/hooks/useStripe.ts"])
```

---

## Session 2 — Tuesday

### Start (snapshot loads automatically)
```
session_start("stripe-project", "cursor", slim=true)
```

`_snapshot` shows yesterday's summary. Warnings about webhook signatures still load first.

### Continue
```
task("stripe-project", "done", "1")   # position 1 = highest priority pending

remember("stripe-project", "idempotency-table",
  "Table: idempotency_keys(key PK, charge_id, status, created_at)", "fact")
```

### End
```
session_end("stripe-project", "cursor", "Idempotency table + migration done", ["prisma/schema.prisma"])
```

---

## Session 3 — Wednesday

### Audit memory health
```
health("stripe-project")
token_budget("stripe-project")
```

If prefix overlap (e.g. 4+ `webhook-*` keys):
```
compress("stripe-project",
  keys=["webhook-signature", "webhook-retry", "webhook-idempotency"],
  new_key="webhook-summary",
  new_value="Unified webhook handling: verify signature → check idempotency → enqueue job")
```

### Export for teammate
```
export_project("stripe-project")
```

---

## Key takeaways

| Pattern | Tool |
|---------|------|
| Start every session | `session_start(slim=true)` |
| Search before remember | `search(mode="hybrid")` |
| Critical gotchas | `remember(..., "warning")` |
| Architecture choices | `decision` |
| End every session | `session_end` + files |
| Overlapping keys | `compress` |
| Project health | `health` + `token_budget` |
