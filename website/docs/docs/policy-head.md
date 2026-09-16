---
title: Policy head
---

# Policy head

An agent driving a device spends most of its wall clock deciding, not acting. A snapshot returns in
roughly 400 ms and a press settles in one to ten seconds, but the model reading that snapshot and
choosing a ref usually takes several seconds and costs a full inference. Over a twelve-step sign-in
flow that is the largest single line in the bill and the longest single phase of the run.

A policy head answers only the narrow question — which of these elements advances this goal — as a
typed decision with calibrated probabilities. It does not write text, plan, or explain. `suggest`
asks it once. `act` puts it in a loop.

The feature is optional and off by default. Without `TYPESAFE_API_KEY` in the environment both
commands refuse before touching the device, and nothing else in the CLI behaves differently.

## Asking once

```bash
agent-device suggest "sign in and reach the main list"
```

```
Goal: sign in and reach the main list
Screen: Sign in with your phone. | Phone number | Send code
Next: fill @e7 at confidence 0.99 (blocked)
Probabilities: @e7 99.0%, @e9 0.6%, __none__ 0.4%
Timing: snapshot 412ms decide 198ms
Cost: $0.000017 for 412 input tokens
```

`suggest` takes one interactive snapshot and prints the decision. It performs no action, so it is
safe to run repeatedly while working through a flow by hand. With `--json` the same decision comes
back as a typed object: `target`, `action`, `confidence`, `probabilities`, `done`, `blocked`,
`needsText`, plus the timing and token cost.

## Running the loop

```bash
agent-device act "sign in and reach the main list" \
  --input phone=5555550100 \
  --max-steps 10
```

Each step snapshots, asks the policy, presses or fills, and snapshots again. The run ends when the
policy reports the goal done, reports it blocked, or three unproductive steps happen in a row.

| Flag | Meaning |
| --- | --- |
| `--policy <name>` | Which head to ask. `jev` is the default and the only one today. |
| `--max-steps <n>` | Step budget for the run. Default 12. |
| `--min-confidence <n>` | Escalate instead of acting below this confidence. Default 0.4. |
| `--input <key=value>` | Repeatable. Text the loop may enter. |

## Text is supplied, never generated

The policy chooses *where* text goes. It never chooses *what* the text is. A field the policy picks
is filled from an `--input` entry whose key matches the field's accessibility identifier or label,
first exactly and then as a substring.

A press on a text field only focuses it, so the loop reads the supplied entry rather than the field's
emptiness to decide what to do. A field whose value is not the supplied text is rewritten, which is
what reaches past a development default the caller overrode. A field already holding that text is
pressed, so the loop cannot spend its whole budget refilling one field. A field that is empty with no
matching entry escalates.

For a value that should not appear in a command line or a shell history, set
`AGENT_DEVICE_INPUT_<KEY>` in the environment instead. A one-time code fetched from a test backend
belongs there:

```bash
AGENT_DEVICE_INPUT_CODE=$(fetch-test-otp) agent-device act "finish signing in"
```

The step record names the input key that was used. It never records the value.

## What the loop checks after it acts

**Same-screen check.** After every action the loop re-snapshots and compares a content digest of the
screen: roles, names, values, and disabled states, with refs deliberately excluded because they are
reissued per snapshot generation. An action that leaves the digest unchanged is recorded as a dead
action rather than counted as progress, and three in a row end the run.

**Digit fields.** A code or PIN field is often a row of single-character boxes over a hidden input.
`fill` reports success, the accessibility value never changes, and the submit button stays disabled.
When the loop sees a fill of all-digit text that did not land, it enters the digits one at a time on
the on-screen keypad, taking a fresh snapshot per key because refs are reissued after every press.

**Ref pinning.** Every mutation is pinned to the generation of the snapshot that issued its ref, so a
decision made against a screen that has since changed is refused rather than landing on whatever
element inherited the ref.

## Blocked is about the screen, not the goal

A head asked "is progress blocked" will say yes on any sign-in screen, because an unauthenticated
screen is literally a login wall. It says so while also naming the phone field at very high
confidence. The loop acts on a target named at 0.9 confidence or above even when `blocked` is set,
and takes the flag at face value below that. Without this a sign-in flow stalls on step one.

## When the head is unreachable

Failures are typed, carry the HTTP status, and name the recovery:

```
Jev unavailable: 429 rate limit exceeded; fall back to agent-driven policy
```

| Status | `reason` | Retriable |
| --- | --- | --- |
| 401, 403 | `policy-provider-unauthorized` | no |
| 402 | `policy-provider-payment-required` | no |
| 429 | `policy-provider-rate-limited` | yes |
| 5xx, transport | `policy-provider-http`, `policy-provider-transport` | yes |

The documented fallback is the agent's own loop: `snapshot`, choose an element, `press` or `fill`.
That path is always available and is what the CLI does today. The policy head accelerates it; it is
never a dependency.

## Limitations

- Needs an API key. There is no offline or local head.
- Decides between elements only. It writes no text and plans no multi-screen strategy.
- Keeps concurrency low. More than about four parallel calls invites rate limiting.
- Reads the accessibility tree, so an element the snapshot cannot see is an element the policy
  cannot choose.
