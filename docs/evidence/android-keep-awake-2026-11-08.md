# Android keep-awake end-to-end run and the svc-true no-op, 2026-11-08

Evidence for #4290 (keep-awake on and off on Android): the
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

HarmonyOS keep-awake moved out of #4290 (maintainer option B): no device was
reachable to prove a restore route, and on JDY-AL50 (HarmonyOS 7.0.0.111)
`power-shell timeout -r` acks but does not clear an active `-o` override (the
screen stayed up past 260s). The finding is recorded in the PR thread; a
future PR may bring the half back behind a proven restore route.

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
