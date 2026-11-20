# HarmonyOS open foreground verification, 2026-11-08

Evidence for #4293 (verify foreground after open instead of trusting the
launch line): the post-check reads the mission list live after the dispatch
and only then reports the open. On this device `aa dump -l` names the
foreground bundle per mission, which is exactly what the poll consumes.

All runs below are at the head that reports the poll as one state:
`other-foreground` names a holder, `no-foreground` is a read that answered
with no foreground mission, and `probe-failed` is a budget whose every read
failed to run.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB, `hdc shell` as uid 2000 (shell)

## The confirmed path, live at the head

A plain open of an idle app confirms within the first poll read and rides
with no verification fact and no warning:

```json
{"success": true, "data": {"appName": "com.stringzhao.moonwell",
  "warnings": null}}
```

The mission list read the same seconds after the dispatch:

```sh
$ hdc -t 77TYD26826028730 shell "aa dump -l"
        bundle name [com.stringzhao.moonwell]
        state #FOREGROUND  start time [914348158]
```

## The keyguard shape of the mission list, observed live

With the screen suspended, `aa dump -l` answers with missions and no
`state #FOREGROUND` line anywhere (12 missions, all `#BACKGROUND`) — the
read that the poll classifies as `no-foreground`:

```sh
$ hdc -t 77TYD26826028730 shell "power-shell suspend"
SuspendDevice is called
$ hdc -t 77TYD26826028730 shell "aa dump -l" | grep -c "state #FOREGROUND"
0
```

This unit could not carry that shape through a full open: a shell-launched
`aa start` wakes the screen and takes the foreground even from the
suspended state (the poll confirmed on its first read, twice, with a fresh
`start time` on the relaunch). Crossing a secure keyguard needs the unlock
PIN, which this evidence session does not handle, so the end-to-end
`no-foreground` open remains maintainer-runnable.

## The maintainer-run protocol for the secure keyguard

The run needs a unit whose secure (PIN) keyguard `aa start` does not
dismiss. Record three outputs at the current head:

1. Plain `open <bundle> --platform harmonyos` prints the
   open-not-foreground warning.
2. `open <bundle> --platform harmonyos --foreground --json` fails with
   `error.details.reason` `open-not-foreground`, the "Unlock the device
   screen" hint, and "within 5s".
3. The raw `aa dump -l` from the locked unit shows mission blocks with
   zero `state #FOREGROUND` lines, or section headers with no mission
   blocks at all.

If the dump carries a shape neither rule classifies as
`no-foreground-mission`, fix the parser for it in the same push.

One wider keyguard shape is pinned in the suite without a live row: a dump
that answers with its section headers (`User ID #`) but no `Mission ID #`
block at all (a lock screen that hides the mission list). The parser
classifies it as `no-foreground-mission` — the unlock-hint path — and
keeps `unparseable` for an empty answer and for `aa` error text, so a
locked unit cannot fall through to the connection hint.

## The failed-probe path, live at the head

The second unconfirmed classification uses the maintainer's offered stub:
a shim `hdc` on the daemon's PATH returns exit 1 with stderr
`shim: poll read refused` for every `aa dump -l`, and passes every other
invocation to the real binary. The launch dispatch is the real dispatch
against the real device; only the poll's reads fail, the way a flaky
connection fails them.

Plain open stays green and carries the unreadable-probe warning:

```json
{"success": true, "data": {"warnings": ["The launch dispatch succeeded,
  but the foreground probe could not read the device within 5s
  (open-foreground-probe-unreadable). This claims nothing about whether
  the app reached the foreground; check the device connection, then run
  the open again."]}}
```

`--foreground` fails hard with the same classification:

```json
{"success": false, "error": {"code": "COMMAND_FAILED",
  "message": "The launch dispatch for com.stringzhao.moonwell succeeded,
  but the foreground probe could not read the device within 5s",
  "hint": "Check the device connection, then run the open again.",
  "details": {"reason": "open-foreground-probe-unreadable",
    "dispatched": "unknown"}}}
```

The `dispatched: "unknown"` disclosure comes from the request dispatch
ledger.

## Decision paths pinned by the suite

- `pollHarmonyOpenForeground classifies a mission list with no foreground mission as no-foreground` — the lock-screen shape
- `pollHarmonyOpenForeground reports probe-failed when every read fails`
- `pollHarmonyOpenForeground names the app that kept the foreground when the launch never surfaces` — `other-foreground`
- `verifyHarmonyOpenForeground attaches no-foreground when a read answered with no foreground mission`
- `verifyHarmonyOpenForeground fails --foreground with the unreadable reason when every read fails`
- plus the confirmed, keep-polling, and abort shapes

## Suite

`packages/platform-harmonyos/src/__tests__/app-lifecycle.test.ts`: 32 tests
pass on this branch's build; the full `check:unit` suite is green (20109
tests, lint clean) with `origin/main` pointed at the upstream base. The
count includes the clamped probe-failed window case: a deadline about 2s
out with every read failing asserts `within 2s`, so a revert to a literal
`5s` fails the suite.

## 2026-11-19 re-attempt at head d295556df

The keyguard re-check: with the screen suspended the mission list shows the
no-foreground shape again (11 missions, zero `state #FOREGROUND`), and the
`open --relaunch` dispatch again wakes this unit past the suspended state —
the poll confirmed on its first read and two missions went FOREGROUND. The
end-to-end `no-foreground` open keeps needing the secure keyguard; a
maintainer run at this head remains the path.

## The failed-probe path re-captured at head d295556df

The shim-hdc protocol (every `aa dump -l` answers exit 1; the dispatch is
the real dispatch on the real device):

```json
{"success": false, "error": {"code": "COMMAND_FAILED",
  "message": "The launch dispatch for com.stringzhao.moonwell succeeded,
  but the foreground probe could not read the device within 5s",
  "hint": "Check the device connection, then run the open again.",
  "details": {"reason": "open-foreground-probe-unreadable"}}}
```

The window text stays "within 5s" here because the CLI request's deadline
left the full budget — the deadline wording fires only when the deadline
actually clamped the poll (pinned by the partly-clamped and spent-deadline
tests).
