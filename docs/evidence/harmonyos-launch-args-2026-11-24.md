# The launch-args lowering on the JDY-AL50, at head 07bce08, 2026-11-24

Live evidence for #4287 (the review's five cases at
`07bce0897726eaad21823f4349cad1627d86cc30`). Device: JDY-AL50 (华为畅享 90
Plus), HarmonyOS 7.0.0.111 (SP10C00E111R4P3), USB serial `77TYD26826028730`.
Runs through `node bin/agent-device.mjs` after `pnpm build` +
`pnpm clean:daemon`, state dir `/tmp/ad4287-state`. Target app:
`com.sankuai.dianping` (ability `EntryAbility`, module `nova`). Every run
below forced the app stopped first (`aa force-stop`), so the foreground state
ties to that launch; each case closes with `aa force-stop` again.

## Receipt limits, stated up front

`aa dump -a` on this build prints the ability record (`state #FOREGROUND`,
`main name [EntryAbility]`) but never prints want parameters, and the app has
no parameter-echo surface, so parameter *receipt* is not observable on this
device. What the run observes is what the review's rule asks the transport to
prove: each entry either reaches `aa start` as exactly one literal operand or
is refused typed before any hdc call — pinned by the `hdc shell echo <word>`
probes in the (c) section.

## (a) `--activity` with `--launch-args --ps k v`

```
$ aa force-stop com.sankuai.dianping         → "force stop process successfully."
$ node bin/agent-device.mjs open com.sankuai.dianping --platform harmonyos \
    --activity EntryAbility --launch-args --ps --launch-args k \
    --launch-args v --json
success: true
$ aa dump -a → Mission ID #50 … main name [EntryAbility] … state #FOREGROUND
```

## (b) The same without `--activity` (the `bm dump` + `-m` route)

```
$ aa force-stop com.sankuai.dianping
$ node bin/agent-device.mjs open com.sankuai.dianping --platform harmonyos \
    --launch-args --ps --launch-args k --launch-args v --json
success: true   (the bm dump resolved EntryAbility/nova; the launch succeeded)
```

## (c) The word with `$(id)`, a double quote and a backslash — reproduced, root-caused

```
$ aa force-stop com.sankuai.dianping
$ node bin/agent-device.mjs open com.sankuai.dianping --platform harmonyos \
    --activity EntryAbility --launch-args --ps --launch-args k \
    --launch-args '$(id)"q"\c' --json
ERROR: COMMAND_FAILED  details.output: `/bin/sh: syntax error: unexpected '('`
```

Control on the same route: `--launch-args plainword` → `success: true`, so
the route itself is healthy and the failure is the word.

Root cause, pinned with `hdc shell echo` (raw hdc 3.2.0f, no agent-device
code in the loop — the host argv element is the last word of
`hdc -t <serial> shell echo <element>`):

| host argv element | device stdout |
|---|---|
| `plainword` | `plainword` |
| `a b` | `a b` (one element survives as one operand) |
| `\$(id)` (the funnel's double-quote escape) | `/bin/sh: syntax error: unexpected '('` |

`hdc shell` does not double-quote host argv elements on the device side — the
element reaches the device's `/bin/sh` wrapped so that the backslash escapes
stay literal, so `renderDoubleQuotedShellWord`'s `\$(id)` arrives as `\$(id)`
whose `$(` the device shell still parses. The funnel's premise (hdc
double-quotes each element, so backslash-escaping the live characters is
enough) does not hold on this transport at this version: single quotes are
what keep the word literal, and inside them the backslashes need no
escaping. This is the transport defect the review's (c) pointed at; the fix
belongs at the owner (`renderShellWord` in the kernel `device-shell.ts`), and
until it lands the help's "forwarded verbatim" sentence is false for words
carrying `\`, `$`, `"` or a backtick on hdc — exactly the narrowing the
review allowed.

## (d) `--launch-args ''`

```
ERROR: INVALID_ARGS  details.reason: hdc-empty-word-unsupported
```

Typed before any hdc call, as the help claims.

## (e) A lone `--launch-args --ps`

```
$ node bin/agent-device.mjs open com.sankuai.dianping --platform harmonyos \
    --activity EntryAbility --launch-args --ps --json
ERROR: COMMAND_FAILED: Failed to start com.sankuai.dianping
  (aa rejected `--ps` with a missing value: "invalid number of parameters
   for option --ps" — the CLI carried the flag word through and the launch
   failed device-side.)
```

## Environment

- host: macOS 27.2, agent-device worktree at head `07bce08` (PR #4287),
  `pnpm build` + `pnpm clean:daemon` before the runs
- device: JDY-AL50, HarmonyOS 7.0.0.111, hdc 3.2.0f
- every case: `aa force-stop com.sankuai.dianping` before and a `close`
  (`aa force-stop`) after
