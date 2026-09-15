# Selectors

Use `find` to locate elements by semantic attributes instead of raw refs.

```bash
agent-device find "Settings" click
agent-device find text "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find value "Search" click
agent-device type "query"
agent-device find role button click
agent-device find id "com.example:id/login" click
```

Tips:

- Use `find ... wait <timeoutMs>` to wait for UI to appear.
- Combine with scoped snapshots using `snapshot -s "<label>"` for speed.
- \[Android] If a matched node is not hittable, agent-device will click/focus the nearest hittable ancestor.
- Use `fill` when you want find-plus-targeted text replacement in one step. Use `click` or `press` plus `type` when you need append semantics in the focused field.

## Response shape (click)

`find "<query>" click --json` returns deterministic matched-target metadata derived from the resolved snapshot node:

```json
{
  "ref": "@e3",
  "locator": "any",
  "query": "Sign In",
  "x": 195,
  "y": 422
}
```

- `ref` — snapshot ref of the matched (or nearest hittable ancestor) element.
- `locator` — find strategy used (`any`, `text`, `label`, `value`, `role`, `id`).
- `query` — the search term as provided.
- `x`, `y` — tap coordinates derived from the matched element's rect center.
