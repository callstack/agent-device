# Rewrite Old Gesture Commands

`swipe`, `gesture fling`, and `gesture swipe` don't take a duration, and `gesture rotate` doesn't
take a velocity. A command, script, or client call that passes one fails with an `INVALID_ARGS`
error that names its replacement; nothing is silently reinterpreted.

Find your surface below — CLI, Node.js, MCP, or saved `.ad` recordings — and apply its rewrite.

## Throws and drags

Gesture commands separate a _throw_ from a _deliberate drag_:

- `swipe` and `gesture fling` are quick, fixed-duration directional throws. They do not take a
  duration; a timed movement is a drag, which is `gesture pan`.
- `gesture pan` is the deliberate timed translation. It keeps `durationMs`.
- `gesture rotate` derives its pacing from the requested `degrees`.

`durationMs` remains on `gesture pan` and `gesture transform`.

## CLI

| Old form                                            | Use instead                              |
| --------------------------------------------------- | ---------------------------------------- |
| `swipe x1 y1 x2 y2 durationMs`                      | `gesture pan x1 y1 dx dy durationMs`     |
| `gesture fling <direction> x y distance durationMs` | `gesture fling <direction> x y distance` |
| `gesture swipe <preset> durationMs`                 | `gesture swipe <preset>`                 |
| `gesture rotate degrees x y velocity`               | `gesture rotate degrees x y`             |

`gesture pan` takes an origin plus a **delta**, where `swipe` took two absolute points, so
`dx = x2 - x1` and `dy = y2 - y1`:

```bash
# before
agent-device swipe 197 650 197 300 300
# after — same motion, same 300ms
agent-device gesture pan 197 650 0 -350 300
```

If you wanted a throw and the duration did not matter, drop the duration instead. The result is a
100ms fling, which travels further on a scrollable list than a 300ms drag over the same distance:

```bash
agent-device swipe 197 650 197 300
```

The error message includes both rewrites with your coordinates filled in:

```
swipe accepts 4 arguments: x1 y1 x2 y2. The trailing durationMs positional was removed:
use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300"
for a default-duration swipe.
```

## Node.js

`interactions.swipe`, `interactions.fling`, and `interactions.swipeGesture` don't accept
`durationMs`; `interactions.rotateGesture` doesn't accept `velocity`. Passing them is a type
error at compile time and an `INVALID_ARGS` rejection at runtime. The client rejects the call before
it reaches the daemon, so plain JavaScript and stale compiled builds get the error rather than a
silently retimed gesture.

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

The `swipe`, `gesture` (`fling`, `swipe` kinds), and `gesture rotate` tool schemas don't
advertise `durationMs` or `velocity`, so an agent reading the schema will not produce the old
form. An agent that sends one anyway — from a cached schema or a memorized example — gets an
`INVALID_ARGS` rejection that names the rejected key and the command to use instead, for example
`gesture fling does not accept durationMs; use gesture pan for timed movement`. Unlike the CLI and
`.ad` errors, the MCP error names the replacement command without a filled-in rewrite.

You do not need to change your MCP server configuration.

## Saved `.ad` recordings

`.ad` scripts keep their positional syntax, which matches the CLI (see
[Positional `.ad` syntax](#positional-ad-syntax) below). Remove only the duration or velocity
argument.

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

A duration held in a variable (`swipe 197 650 197 300 ${DURATION}`) is reported the same way: the
check counts arguments, so it does not need the value.

**Running your scripts is the definitive check.** Every old form is rejected when the script is
parsed, before the replay runs any device action, so `agent-device test <glob>` or
`agent-device replay <file>.ad` finds and names every stale line. To locate them in bulk without a
device, use the patterns below. They split tokens on any whitespace (space or tab) and match a bare
or double-quoted number or `${VAR}` in each numeric slot, so `swipe\t…\t"300"` is flagged like
`swipe … 300`. They miss rarer spellings, such as a quoted command word or backslash escapes inside a
quoted token, so treat a clean grep as a first pass and the run as the proof.

```bash
# a numeric slot: bare/quoted number (optionally signed) or ${VAR}. Requiring a
# digit keeps a following flag like --count from being read as the extra slot.
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

Instead of editing by hand, you can re-record: the recorder writes the current form, so a fresh
`open --save-script` → interact → `close` run produces a script in the current form. Recording starts at
`open`, so pass `--save-script` there; `close --save-script` on a session opened without it is
rejected.

### Maestro flows

Maestro `swipe` with a `duration` is **not** affected, and Maestro flows need no changes.
`agent-device` runs a timed Maestro swipe as `gesture pan` and keeps Maestro's
fast-swipe-then-hold timing.

`replay export` writes an explicit `duration: 100`, the fling duration, so an exported flow runs at
the speed the `.ad` script ran instead of Maestro's 400ms default.

## Positional `.ad` syntax

Positional gesture arguments in `.ad` are the file format itself, not a compatibility shim. `.ad` is
a line-based script format that uses the CLI's syntax. Node.js and MCP send structured input; the CLI and
`.ad` files use positional arguments. Keeping `.ad` positional keeps recordings readable and
searchable with grep.

See [ADR 0013](https://github.com/callstack/agent-device/blob/main/docs/adr/0013-unified-gesture-plans.md)
for the gesture normalization and planning model this rests on.
