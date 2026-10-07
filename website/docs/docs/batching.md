---
title: Batching
---

# Batching

Use `batch` to run several commands in one daemon request. It saves round trips when you already know
the next sequence of actions.

## Run a batch from the CLI

From a file:

```bash
agent-device batch \
  --session sim \
  --platform ios \
  --udid 00008150-001849640CF8401C \
  --steps-file /tmp/batch-steps.json \
  --json
```

Inline, for small payloads:

```bash
agent-device batch --steps '[{"command":"open","input":{"app":"settings"}},{"command":"wait","input":{"kind":"duration","durationMs":100}}]'
```

## Step payload format

Pass `batch` a JSON array of steps:

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

- `input` is required and takes the same fields as the matching MCP or Node client command.
- A step can only have `command`, `input`, and `runtime` keys; any other key is rejected.
- Steps written as `positionals`/`flags` are rejected (that shape was removed in 0.21). Rewrite each step with structured input, for example `{"command":"open","input":{"app":"settings","platform":"ios"}}`.
- `batch` and `replay` steps can't be nested inside a batch.
- `--on-error stop` is the only error mode: the batch stops at the first failing step.
- A batch runs at most 100 steps by default. Pass `--max-steps <n>` to raise or lower the limit, up to 1000.
- A step without `platform` uses the batch's `--platform`. Session lock defaults don't override it.
- Steps use the same session binding and [session lock mode](/docs/sessions#lock-a-named-session-to-a-device) as the `batch` command itself.

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

Without `--json`, `batch` prints the overall completion line followed by a short summary of each step.

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

## Tips for agents

- Keep each batch to one screen flow.
- After steps that change the UI (`open`, `click`, `fill`, `swipe`), add a `wait` or `is exists` step before reads that matter.
- Treat earlier refs and snapshots as stale after the UI changes.
- Prefer `--steps-file` over inline JSON.
- Keep batches to about 5-20 steps.
- When a batch fails, use `details.step` and `details.partialResults` to replan from the failing step.

## Example recipes

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

## Avoid acting on a stale accessibility tree

The accessibility tree can lag behind fast UI changes. Add explicit waits, and split long workflows
into separate batches by phase:

1. navigate
2. verify/extract
3. cleanup
