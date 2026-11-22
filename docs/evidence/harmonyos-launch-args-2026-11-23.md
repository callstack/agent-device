# HarmonyOS open --launch-args forwarding, 2026-11-23

Evidence for #4287 (forward `open --launch-args` to `aa start` verbatim), re-run at the
rebased head. The option forwards each entry as one argument of the `aa start` argv. The
CLI adds no `--ps`/`--pi` words of its own: every parameter word in this run is one the
caller chose.

## Build under test

- Source SHA `306a2f397`, branch `forge/launch-args-harmony`, commit
  `feat(harmonyos): forward open --launch-args to aa start verbatim`
- Build: `pnpm install --frozen-lockfile && pnpm build` in the branch worktree. The CLI
  and the daemon ran from that dist.
- The daemon ran under an isolated `AGENT_DEVICE_HOME`, so no other build served these
  commands.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26, USB
- Serial `<serial>`. The app is a personal data-carrying user app, driven read-only and
  named `<bundle>` below.

The app is force-stopped before cases (a), (b) and (c), so the recorded foreground state
belongs to that launch.

## (a) `--activity` route with parameter words

```sh
$ agent-device open <bundle> --platform harmonyos --serial <serial> --activity EntryAbility \
    --launch-args --ps --launch-args k --launch-args v
Opened: <bundle>
$ hdc -t <serial> shell "aa dump -l"
    Mission ID #102  mission name #[#<bundle>:entry:EntryAbility]  lockedState #0  mission affinity #[]
      AbilityRecord ID #21149
        app name [<bundle>]
        main name [EntryAbility]
        bundle name [<bundle>]
        ability type [PAGE]
        state #FOREGROUND  start time [1444191858]
        app state #FOREGROUND
        ready #1  window attached #0  launcher #0
```

## (b) no `--activity`, the `bm dump` route

```sh
$ agent-device open <bundle> --platform harmonyos --serial <serial> \
    --launch-args --ps --launch-args k --launch-args v
Opened: <bundle>
```

The `aa dump -l` mission block matches case (a). The unit test
`openHarmonyApp keeps the module flag ahead of launch args on the bm dump route` pins the
argv: `-m <module>` precedes the forwarded entries.

## (c) a value with shell-live characters: the launch fails, and that is the finding

The review asks that a value carrying `$`, `"` and `\` arrives literally with nothing
executed. At this head it does not arrive at all:

```sh
$ agent-device open <bundle> --platform harmonyos --serial <serial> --activity EntryAbility \
    --launch-args '$(id)"q"\c'
Error (COMMAND_FAILED): Failed to start <bundle>
[exit=1]
```

The failure reproduced twice, with the app force-stopped before each attempt. A manual
`hdc shell aa start ... --ps <value>` with the unescaped value, run after the session as a
diagnostic, answers `invalid number of parameters for option --ps`. That repro bypasses
the branch's escaping, so it shows only how `aa` counts operands. The branch run's own
device-side stdout was not captured in the request log. What the two branch runs prove is
narrower: at this head, a value with shell-live characters fails the launch instead of
arriving verbatim. Whether the device shell expands anything before the grammar rejects
the word is not determinable from the captured output. Finding the reshaping layer (the
`hdc` argv join, or the device shell) needs one instrumented probe, and the transport
claim in this PR does not hold until that lands.

## (d) empty entry: typed refusal before any device call

```sh
$ agent-device open <bundle> --platform harmonyos --serial <serial> --activity EntryAbility \
    --launch-args ""
Error (INVALID_ARGS): hdc drops an empty element instead of carrying it, so the device
command would lose an operand. May have reached the device. Next: Run snapshot to check
the screen before you retry. Pass a value the transport can carry, or use a device action
that needs no operand.
[exit=1]
```

## (e) lone `--ps` word: `aa` refuses the operand grammar

```sh
$ agent-device open <bundle> --platform harmonyos --serial <serial> --activity EntryAbility \
    --launch-args --ps
Error (COMMAND_FAILED): Failed to start <bundle>
[exit=1]
```

A single `--ps` leaves `aa` without a value operand, and the CLI reports the start
failure as `COMMAND_FAILED`.

## Receipt is not observable at default levels, stated plainly

- `aa dump -l` and `aa dump -a` print no parameter lines for the mission.
- After a cleared hilog ring, a launch with `--ps evidence_key_4287 evidence_value_4287`
  leaves zero grep hits in `hilog -x`.

This run proves an accepted dispatch with the forwarded argv and a clean foreground
launch. It does not prove in-app receipt. Proving receipt needs an instrumented build;
this session drove a user-built app and could not add one.

## Guard

`assertOpenDeviceSupport` refuses `--launch-args` on Linux
(`packages/contracts/src/application-lifecycle-interaction.ts`). macOS rejects the flag in
the Apple launch path.

## Cleanup

`close <bundle>` ran after the last case and answered `Closed: default`.
