# Android keep-awake end-to-end run and the svc-true no-op, 2026-11-08

Evidence for #4290 (keep-awake on and off across Android and HarmonyOS): the
first backend draft lowered `on` to `svc power stayon true`, and a live run
proved that a no-op on real hardware — the command answers and the stored
value never moves when the mask already covers the plugged-in sources. The
shipped backend writes the setting itself and reports the read-back state.

## Device

- Xiaomi Redmi K60 (`2312DRAABC` model code), Android 14 (SDK 34), adb serial
  `5p4hqglvpzxshiuw`, USB connected.

## The svc-true no-op (discovered live)

With the user's stored mask at `15`, the draft command changed nothing while
the CLI still acked the write:

```sh
$ adb -s 5p4hqglvpzxshiuw shell "settings get global stay_on_while_plugged_in"
15
$ adb -s 5p4hqglvpzxshiuw shell "svc power stayon true; settings get global stay_on_while_plugged_in"
15
$ adb -s 5p4hqglvpzxshiuw shell "svc power stayon usb; settings get global stay_on_while_plugged_in"
2
```

`stayon true` does not rewrite a mask that already covers the plugged-in
sources; `stayon usb` rewrites to `2`. A write that skips no-op spellings is
the only reliable form.

## The shipped backend, end to end through the public CLI

Branch build of #4290, one command per state, device state read back with raw
`settings get` between the calls:

```sh
$ node bin/agent-device.mjs settings keep-awake on --platform android --serial 5p4hqglvpzxshiuw
Updated setting: keep-awake
$ adb -s 5p4hqglvpzxshiuw shell "settings get global stay_on_while_plugged_in"
7
$ node bin/agent-device.mjs settings keep-awake off --platform android --serial 5p4hqglvpzxshiuw
Updated setting: keep-awake
$ adb -s 5p4hqglvpzxshiuw shell "settings get global stay_on_while_plugged_in"
0
```

`15 → 7 → 0`. The user's stored mask was restored to `15` after the run. The
CLI result carries the read-back state (`stayOnWhilePluggedIn`), so an ack can
never claim a write the device did not store.

## HarmonyOS note

`power-shell` on JDY-AL50 (7.0.0.111) has no query form: `setmode` spells only
the 600-series modes, `timeout -o <ms>` acks with `Override screen off time to
2147483647`, and `timeout -r` restores. The harmony backend uses the timeout
override for exactly this reason.

## The live Android repro at head 73d04eb4a (2026-11-23)

The review asked for a device where `svc power stayon true` fails, or the
hand-written mask dropped for the toggle read-back. The Redmi 2312DRAABC
(Android 14, MIUI) answers the question from the other side:

```sh
$ adb shell settings get global stay_on_while_plugged_in
0
$ adb shell svc power stayon true
$ adb shell settings get global stay_on_while_plugged_in
15
$ adb shell svc power stayon false
$ adb shell settings get global stay_on_while_plugged_in
0
```

`svc power stayon true` writes 15 from a 0 row on this unit — the original
lowering keeps the screen on here, and `false` returns the row to 0. The
shipped 7 write would clobber a 15 a dock or user had set, so the lowering now
rides the global-toggle machinery: `svc power stayon true|false`, the row
polled to a state (`0` disabled, any positive mask enabled), and the typed
`keep-awake-not-applied` / `keep-awake-unreadable` reasons on a read-back that
did not move or is not a mask. The result is `{ keepAwake }` only.

## The HarmonyOS half, live at head 86439819-era build (2026-11-23)

Ran on the JDY-AL50 through the branch CLI (`settings keep-awake on|off
--platform harmonyos --json`, both answer `keepAwake: enabled|disabled`), with
the screen state read from `hidumper -s DisplayPowerManagerService`
(`State=0` is screen off):

- Baseline, keep-awake off: wake, then screen off at **198s** — the untouched
  system timer.
- keep-awake on (`timeout -o 2147483647`): wake, then **no screen off through
  360s** (the display sits dimmed, `State=2`, and never reaches 0). The
  override holds the screen up past the system timer.
- A 10-second override confirms `-o` is honored: screen off at **12s**.
- keep-awake off (`timeout -r`): **the restore fails on this unit.** After the
  ack ("Restore screen off time"), the screen stayed up past 260s in an
  isolated cycle, and again after a fresh suspend/wake. The baseline 198s was
  the system timer with no override active — the first `-r` was a no-op, not a
  restore.

So on 7.0.0.111, `timeout -r` acks but does not clear an active `-o`
override: the PR's "off restores the timeout the system setting holds" does
not hold after a hold has been raised. The unit now sits at an explicit
`timeout -o 180000` (verified: screen off at 185s). Choosing a restore route
that works (a stored pre-override value, or another tool path) is an owner
decision; the CLI cannot read the current timeout to snapshot it.
