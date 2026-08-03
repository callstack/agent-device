---
title: Migrating Gestures
---

# Migrating Gestures

`agent-device` 0.20.0 removed the timed forms of `swipe`, `gesture fling`, and `gesture swipe`, and
the `velocity` argument of `gesture rotate`. Nothing is silently reinterpreted: every removed form
now fails with an `INVALID_ARGS` error that names its replacement.

This page is the migration for all four public surfaces — CLI, Node.js, MCP, and saved `.ad`
recordings — plus the policy that governs the next such removal.

## What changed

Gesture vocabulary now separates a *throw* from a *deliberate drag*:

- `swipe` and `gesture fling` are quick, fixed-duration directional throws. They do not take a
  duration, because a caller-supplied duration made them something else.
- `gesture pan` is the deliberate timed translation. It keeps `durationMs`.
- `gesture rotate` derives its pacing from the requested `degrees`.

`durationMs` remains on `gesture pan` and `gesture transform`.

## CLI

| Removed                                      | Use instead                                     |
| -------------------------------------------- | ----------------------------------------------- |
| `swipe x1 y1 x2 y2 durationMs`               | `gesture pan x1 y1 dx dy durationMs`            |
| `gesture fling <direction> x y distance durationMs` | `gesture fling <direction> x y distance`  |
| `gesture swipe <preset> durationMs`          | `gesture swipe <preset>`                        |
| `gesture rotate degrees x y velocity`        | `gesture rotate degrees x y`                    |

`gesture pan` takes an origin plus a **delta**, where `swipe` took two absolute points, so
`dx = x2 - x1` and `dy = y2 - y1`:

```bash
# before
agent-device swipe 197 650 197 300 300
# after — same motion, same 300ms
agent-device gesture pan 197 650 0 -350 300
```

Drop the duration instead when the timing was incidental and a throw is what you wanted. The
resulting gesture is a 100ms fling, which travels further on a scrollable list than a 300ms drag
over the same distance:

```bash
agent-device swipe 197 650 197 300
```

The error message computes this for you:

```
swipe accepts 4 arguments: x1 y1 x2 y2. The trailing durationMs positional was removed:
use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300"
for a default-duration swipe.
```

## Node.js

`interactions.swipe`, `interactions.fling`, and `interactions.swipeGesture` no longer accept
`durationMs`; `interactions.rotateGesture` no longer accepts `velocity`. Passing them is a type
error at compile time and an `INVALID_ARGS` rejection at runtime — the rejection happens
client-side, before the request reaches the daemon, so a plain JavaScript caller or a stale
compiled build gets the error rather than a silently retimed gesture.

```ts
// before
await device.interactions.swipe({
  from: { x: 197, y: 650 },
  to: { x: 197, y: 300 },
  durationMs: 300,
});

// after — same motion, same 300ms
await device.interactions.pan({ x: 197, y: 650, dx: 0, dy: -350, durationMs: 300 });

// after — a default-duration throw
await device.interactions.swipe({ from: { x: 197, y: 650 }, to: { x: 197, y: 300 } });
```

`interactions.pan` and `interactions.transformGesture` keep `durationMs`.

## MCP

The `swipe`, `gesture` (`fling`, `swipe` kinds), and `gesture rotate` tool schemas no longer
advertise `durationMs` or `velocity`, so an agent reading the schema will not produce the removed
form. An agent that sends one anyway — from a cached schema or a memorized example — gets an
`INVALID_ARGS` rejection that names the removed key and the command to use instead, for example
`gesture fling does not accept durationMs; use gesture pan for timed movement`. This is the
structured-input equivalent of the CLI error; it names the replacement command but, unlike the CLI
and `.ad` messages, does not echo a fully-substituted rewrite, because the structured request
carries no positional string to rewrite.

No MCP server configuration changes.

## Saved `.ad` recordings

`.ad` scripts keep their positional syntax: it is the same vocabulary as the CLI, and it is not
scheduled for removal (see [Positional `.ad` syntax](#positional-ad-syntax) below). Only the removed
arguments have to go.

A script that still carries one fails **when it is parsed**, before the replay executes any device
action, and the error names the line:

```
Error (INVALID_ARGS): swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs
positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or
"swipe 197 650 197 300" for a default-duration swipe.
```

Apply the same rewrites as the CLI table above. Flags are unaffected: `--count`, `--pause-ms`, and
`--pattern` stay on `swipe`, and `--pointer-count` stays on `gesture pan`.

```
# before
swipe 206 650 206 300 300 --count 2 --pause-ms 200 --pattern one-way
# after
swipe 206 650 206 300 --count 2 --pause-ms 200 --pattern one-way
```

A duration held in a variable (`swipe 197 650 197 300 ${DURATION}`) is reported the same way — the
preflight counts arguments, so it does not need the value.

**The authoritative check is the parser itself.** Every retired form is rejected when the script is
parsed, before the replay runs any device action, so running the suite (`agent-device test <glob>`,
or `agent-device replay <file>.ad`) finds every stale line by construction and names it — a missed
grep can never let one reach execution. The patterns below are a bulk pre-flight to locate them
without a device. They follow the `.ad` tokenizer: tokens are separated by any whitespace (space or
tab), and the numeric slots accept a bare or double-quoted number or `${VAR}` — so
`swipe\t…\t"300"` is flagged like `swipe … 300`. They still stop short of the tokenizer's rarer
encodings (a quoted command word, backslash escapes inside a quoted token), which is why the parser,
not the grep, is the gate.

```bash
# a numeric slot: bare/quoted number (optionally signed) or ${VAR}. Requiring a
# digit keeps a following flag like --count from being read as the retired slot.
num='("-?[0-9][0-9.]*"|"\$\{[^}]*\}"|-?[0-9][0-9.]*|\$\{[^}]*\})'
# swipe x1 y1 x2 y2 durationMs
grep -rnE "\\bswipe([[:space:]]+$num){5}" --include='*.ad' .
# gesture fling <direction> x y distance durationMs
grep -rnE "\\bgesture[[:space:]]+fling[[:space:]]+\"?[a-z]+\"?([[:space:]]+$num){4}" --include='*.ad' .
# gesture swipe <preset> durationMs
grep -rnE "\\bgesture[[:space:]]+swipe[[:space:]]+\"?[a-z-]+\"?[[:space:]]+$num" --include='*.ad' .
# gesture rotate degrees x y velocity
grep -rnE "\\bgesture[[:space:]]+rotate([[:space:]]+$num){4}" --include='*.ad' .
```

Re-recording also produces a migrated script: the recorder writes the canonical form, so a fresh
`open --save-script` → interact → `close` run is a valid alternative to editing by hand. Recording
evidence is only captured from action zero, so arm at `open`; a bare `close --save-script` on a
session that was not armed at `open` is rejected.

### Maestro flows

Maestro `swipe` with a `duration` is **not** affected. `agent-device` runs Maestro YAML through its
own compatibility engine, which normalizes a timed Maestro swipe to the canonical `gesture pan`
input and preserves Maestro's fast-swipe-then-hold execution profile. Maestro flows need no
migration.

`replay export` writes an explicit `duration: 100` — the canonical fling duration — so an exported
flow runs at the speed the `.ad` script ran, rather than picking up Maestro's own 400ms default.

## Deprecation policy

This is the process a public gesture input follows on its way out, and the bar the next removal has
to clear:

1. **Announce.** The input is documented as deprecated and recorded in `CHANGELOG.md` under
   `Unreleased`, together with the replacement.
2. **Warn for one minor release.** The input keeps working and normalizes to the replacement, with a
   `deprecations` entry in the response so an agent sees the migration while the call still
   succeeds.
3. **Publish the migration.** A section on this page covers CLI, Node.js, MCP, and `.ad`, with a
   concrete before/after per surface.
4. **Prove the repository is clean.** A repository-wide search for the removed shape returns no hits
   in fixtures, examples, skills, docs, or tests. `agent-device` has no usage telemetry, so this
   search — plus the migration guide's publication — is the evidence, and it is the reason the
   removal cannot be inferred from "nobody complained".
5. **Remove.** The input is rejected with an `INVALID_ARGS` error that states the replacement, and
   the normalization branch and its compatibility tests are deleted in the same change. For an input
   that can appear in a saved recording, the rejection must fire at parse time and name the line, so
   a stale script never half-executes.

The 0.20.0 removal completed all five steps.

## Positional `.ad` syntax

Positional gesture parsing in `.ad` is **not** a compatibility shim and is not scheduled for
removal.

`.ad` is a line-based script format whose syntax is the CLI's syntax. Its gesture codec —
`gesturePayloadFromPositionals` / `gesturePayloadToPositionals` — is what defines the file format,
not a bridge to an older one. CLI, Node.js, and MCP already send structured input directly; the
codec's only remaining jobs are parsing CLI argv and reading and writing `.ad` lines, and both are
the current public syntax. Replacing it with a structured payload would make recordings
unreadable and ungreppable for no behavioral gain.

See [ADR 0013](https://github.com/callstack/agent-device/blob/main/docs/adr/0013-unified-gesture-plans.md)
for the gesture normalization and planning model this rests on.
