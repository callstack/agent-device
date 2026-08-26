---
title: Batching
---

# Batching

Use `batch` to run multiple commands in a single daemon request.

This is useful for agent workflows that already know the next sequence of actions and want to reduce orchestration overhead.

## CLI examples

From a file:

```bash
agent-device batch \
  --session sim \
  --platform ios \
  --udid 00008150-001849640CF8401C \
  --steps-file /tmp/batch-steps.json \
  --json
```

Inline for small payloads:

```bash
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}},{"command":"wait","input":{"kind":"duration","durationMs":100}}]'
```

## Step payload format

`batch` accepts a JSON array of steps:

```json
[
  { "command": "open", "input": { "app": "settings" } },
  {
    "command": "wait",
    "input": { "kind": "selector", "selector": "label=\"Privacy & Security\"", "timeoutMs": 3000 }
  },
  {
    "command": "click",
    "input": { "target": { "kind": "selector", "selector": "label=\"Privacy & Security\"" } }
  },
  {
    "command": "get",
    "input": { "format": "text", "target": { "kind": "selector", "selector": "label=\"Tracking\"" } }
  }
]
```

Notes:

- `input` is required and uses the same fields as the matching MCP/Node command.
- Unknown top-level step fields are rejected. Supported keys are `command`, `input`, and `runtime`.
- The legacy `positionals`/`flags` step shape was removed in 0.21. Migrate each step to structured input, for example `{"command":"open","input":{"app":"settings","platform":"ios"}}`.
- nested `batch` and `replay` steps are rejected.
- `--on-error stop` is the supported behavior.

## Response shape

Success:

```json
{
  "success": true,
  "data": {
    "total": 4,
    "executed": 4,
    "totalDurationMs": 1810,
    "results": [
      { "step": 1, "command": "open", "ok": true, "durationMs": 1020 },
      { "step": 2, "command": "wait", "ok": true, "durationMs": 320 },
      { "step": 3, "command": "click", "ok": true, "durationMs": 260 },
      { "step": 4, "command": "get", "ok": true, "durationMs": 210, "data": { "text": "..." } }
    ]
  }
}
```

In non-JSON mode, `batch` also prints a short per-step summary after the overall completion line.

Failure:

```json
{
  "success": false,
  "error": {
    "code": "COMMAND_FAILED",
    "message": "Batch failed at step 3 (click): ...",
    "details": {
      "step": 3,
      "command": "click",
      "executed": 2,
      "total": 4,
      "partialResults": [
        { "step": 1, "command": "open", "ok": true },
        { "step": 2, "command": "wait", "ok": true }
      ]
    }
  }
}
```

## Agent best practices

- Batch only one related screen flow at a time.
- After mutating steps (`open`, `click`, `fill`, `swipe`), add a sync guard (`wait`, `is exists`) before critical reads.
- Treat prior refs/snapshots as stale after UI changes.
- Prefer `--steps-file` over inline JSON.
- Keep batches moderate (about 5-20 steps).
- Replan from the failing step using `details.step` and `details.partialResults`.

## Canonical recipes

Open app -> open thread -> type -> send

```json
[
  { "command": "open", "input": { "app": "com.example.chat", "platform": "android" } },
  { "command": "wait", "input": { "kind": "text", "text": "Inbox", "timeoutMs": 3000 } },
  { "command": "press", "input": { "target": { "kind": "selector", "selector": "label=\"Inbox\" role=button" } } },
  { "command": "press", "input": { "target": { "kind": "selector", "selector": "label=\"Morgan Lee\"" } } },
  {
    "command": "fill",
    "input": {
      "target": { "kind": "selector", "selector": "label=\"Message\" role=text-field" },
      "text": "sent the update"
    }
  },
  { "command": "press", "input": { "target": { "kind": "selector", "selector": "label=\"Send\" role=button" } } },
  { "command": "wait", "input": { "kind": "text", "text": "sent the update", "timeoutMs": 3000 } }
]
```

Open app -> open action menu -> choose option -> verify

```json
[
  { "command": "open", "input": { "app": "com.example.app", "platform": "android" } },
  { "command": "wait", "input": { "kind": "text", "text": "Home", "timeoutMs": 3000 } },
  {
    "command": "press",
    "input": { "target": { "kind": "selector", "selector": "label=\"More actions\" role=button" } }
  },
  { "command": "wait", "input": { "kind": "text", "text": "Scan document", "timeoutMs": 2000 } },
  { "command": "press", "input": { "target": { "kind": "selector", "selector": "label=\"Scan document\"" } } },
  { "command": "wait", "input": { "kind": "text", "text": "Document uploaded", "timeoutMs": 15000 } },
  { "command": "is", "input": { "predicate": "visible", "selector": "label=\"Document uploaded\"" } }
]
```

## Stale accessibility tree risk

Rapid UI changes can outpace accessibility tree updates. Mitigate by inserting explicit waits and splitting long workflows into phases:

1. navigate
2. verify/extract
3. cleanup
