---
title: Selectors
---

# Selectors

Use `find` to act on an element by its text, label, value, role, or id instead of a snapshot ref.

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

- `find role <value>` and the `role=` selector term match the platform-neutral `kind` vocabulary that `snapshot --json` publishes (`button`, `text`, `text-field`, `switch`, …). Older leaf spellings (`statictext`, `edittext`, `textview`) still match during a deprecation window, each only on nodes that carried that class.
- Use `find ... wait <timeoutMs>` to wait for an element to appear.
- Pair `find` with a scoped snapshot (`snapshot -s "<label>"`) for speed.
- [Android] If the matched node is not hittable, agent-device clicks or focuses the nearest hittable ancestor.
- Use `fill` to find a field and replace its text in one step. To append to the text in the focused field, use `click` or `press`, then `type`.

## Response shape (click)

`find "<query>" click --json` returns the element it matched:

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
- `locator` — the locator used (`any`, `text`, `label`, `value`, `role`, `id`).
- `query` — the search term as provided.
- `x`, `y` — tap coordinates derived from the matched element's rect center.
