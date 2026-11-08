# HarmonyOS keyboard band fact, live, 2026-11-08

Evidence for #4285 (report the keyboard band in snapshot responses): the
producer's window-manager probe tracks the real IME through a raise and a
dismiss, and the measured band immediately feeds the tap guard — a stale ref
aimed into the keyboard region got refused mid-run.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB
- Surface: system Settings → search bar (tapped at 540,378), no text typed,
  no data touched.

## Hidden → visible → hidden

Snapshot before the keyboard (device on the Settings page):

```json
"/keyboard": {"kind": "visibility-only", "visible": false}
```

The same window-manager dump the producer reads shows the panel window with a
zero rect while hidden:

```
SCBKeyboardPanel ... [ 0    0    0    0    ] [ 0  0  ] [ 1  1  0  0 ]
```

Tap the search bar; the IME rises. The probe now answers a live container and
the snapshot fact flips to the measured band:

```json
"/keyboard": {"kind": "visible", "frame": {"x": 0, "y": 0, "width": 1080, "height": 2406}}
```

After two Back keys the fact returns to
`{"kind": "visibility-only", "visible": false}`.

## The guard consumed the band immediately

Mid-run, a ref captured before the keyboard rose was refused by the tap guard
instead of tapping into the IME strip:

```
Error (COMMAND_FAILED): Ref @e20 is behind the visible keyboard and cannot be tapped safely
```

This is the failure class the evidence session itself hit earlier in the audit
(a coordinate tap landed on the keyboard's suggestion strip and a record was
created with a stray character in its name). With the band reported, the guard
refuses the tap instead.

## Reproduce

```sh
node bin/agent-device.mjs open com.huawei.hmos.settings --activity com.huawei.hmos.settings.MainAbility \
  --platform harmonyos --serial 77TYD26826028730
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # hidden
node bin/agent-device.mjs press 540 378 --platform harmonyos --serial 77TYD26826028730      # search bar
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # visible + frame
node bin/agent-device.mjs back --platform harmonyos --serial 77TYD26826028730              # dismiss
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # hidden again
```
