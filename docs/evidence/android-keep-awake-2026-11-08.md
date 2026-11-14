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
