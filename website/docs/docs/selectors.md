---
title: Selectors
---

# Selectors

Target an element by what it says or is, instead of a snapshot ref. Use `find` to search by text,
label, value, role, or id, or pass a selector expression to any command that takes a target.

```bash
agent-device find "Settings" click
agent-device find text "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find value "Search" click
agent-device type "query"
agent-device find role button click
agent-device find id "com.example:id/login" click
agent-device find "Follow" list
```

## Find an element

`find <locator> <query> <action>` takes an optional locator (`text`, `label`, `value`, `role`, or
`id`), the query, and an action. Without a locator it searches labels, values, and ids. Text
matches ignore case, and a field containing the query matches too; an exact match wins over a
partial one.

Actions:

- `click` (default; `press` and `tap` are aliases)
- `list`
- `focus`
- `fill <text>`
- `type <text>`
- `exists`
- `wait [timeoutMs]`
- `get text`, `get attrs`

`list` is read-only: it returns every match with its `@ref` and never taps, so use it to inspect
matches before you act. `find` has no `longpress` or `swipe` action; run `list`, then run the gesture
on the ref you picked, for example `longpress @e14`.

When more than one element matches, the mutating actions (`click`, `focus`, `fill`, `type`) reject
the query and list the candidates. This applies to text queries and selector expressions alike.
Read-only actions (`exists`, `wait`, `get`) use the first match, and `list` returns every match. Add `--first` or `--last` to pick a match by
position instead.

```bash
agent-device find "Follow" click --first
```

Tips:

- `find role <value>` and the `role=` selector key use the same role names that snapshots show. See
  [Structured node fields](/docs/snapshots#structured-node-fields---json).
- Use `find ... wait <timeoutMs>` to wait for an element to appear.
- Pair `find` with a scoped snapshot (`snapshot -s "<label>"`) for speed.
- [Android] If the matched node is not hittable, agent-device clicks or focuses the nearest hittable ancestor.
- Use `fill` to find a field and replace its text in one step. To append to the text in the focused field, use `click` or `press`, then `type`.

## Selector syntax

A selector expression is one or more `key=value` terms separated by spaces. An element must match
every term. Commands that take a target, such as `press`, `fill`, `longpress`, `get`, `is`, `wait`,
and `scroll --until`, accept a selector wherever they accept an `@ref`. `find` accepts one as its
query.

```bash
agent-device press 'role=button label="Continue"'
agent-device fill 'label="Email" editable=true' "qa@example.com"
agent-device wait 'id="checkout-total"' 5000
agent-device press 'id="submit" || label="Submit order"'
agent-device find 'role=button label="Follow"' list
```

Text keys:

| Key           | Matches                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `id`          | The element's identifier (test ID, resource ID, accessibility identifier)          |
| `label`       | The accessibility label                                                            |
| `value`       | The accessibility value                                                            |
| `text`        | The first non-empty of label, value, and identifier                                |
| `role`        | The role shown in brackets in snapshot output (`button`, `text-field`, `switch`, …) |
| `appname`     | The owning app's name, on desktop targets that report it                           |
| `windowtitle` | The owning window's title, on desktop targets that report it                       |

Text values match the whole field, ignoring case and extra whitespace: `label="sign in"` matches
`Sign In` but not `Sign In Now`. For partial matches, use `find`.

Boolean keys: `visible`, `hidden`, `editable`, `selected`, `focused`, `enabled`, `hittable`. Write
`visible=true` or `visible=false`; a bare `visible` means `visible=true`.

Quoting and alternatives:

- Quote values that contain spaces, with double or single quotes: `label="Sign in"`. Escape a quote
  inside a value with a backslash: `label="Say \"hi\""`.
- Wrap the whole expression in single quotes in the shell so it reaches agent-device as one
  argument.
- Separate alternatives with `||`. agent-device tries them left to right and uses the first one
  that resolves.
- Keys are case-insensitive. Commands that take a target reject an unknown key, such as
  `button="Save"`; write `role=button label="Save"` instead.

## Response shape (click)

`find "<query>" click --json` returns metadata for the element it matched, taken from the resolved snapshot node:

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
