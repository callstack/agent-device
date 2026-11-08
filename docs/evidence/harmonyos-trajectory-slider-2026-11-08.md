# HarmonyOS densified trajectory pan drags a real slider, 2026-11-08

Evidence for #4239 (inject gesture pan as a densified touch-panel
trajectory): one densified pan through the panel evdev chain dragged a real
slider-captcha knob 439 px across its track, and the app's own
machine-readable oracle scored the alignment at 3 px off target — inside its
20 px tolerance, `RESULT=PASS`.

## Device

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB, `hdc shell` as uid 2000 (shell)
- Surface: `com.stringzhao.captchaab`, its slider-puzzle page — a test harness
  app whose status bar carries a machine-readable verdict row
  (`ROUND=... RESULT=... DETAIL=... TYPE=slider`), so the oracle needs no
  screenshots.

## Run

Knob at the track's left edge (x≈165, y≈1084); the puzzle gap sat 439 px to
the right. One densified pan, default transport (the panel node):

```sh
$ node bin/agent-device.mjs gesture pan 165 1084 439 0 900 \
    --platform harmonyos --serial 77TYD26826028730
Panned (165, 1084) by (439, 0)
```

The verdict row before and after:

```
ROUND=1 RESULT=NONE DETAIL=- PASS=0 FAIL=0 TYPE=slider
ROUND=1 RESULT=PASS DETAIL=offset=3px tol=20 PASS=1 FAIL=0 TYPE=slider
```

The after screenshot shows the knob at ≈x 606 on the track and the puzzle
piece seated in the gap. The requested displacement (165 + 439 = 604) and the
scored landing (offset 3 px inside a 20 px tolerance) agree.

## Why this evidences the transport

The slider only moves while a touch sequence holds, carries, and releases it —
a straight-line UIInput swipe also moves it, but this branch's pan lowers the
stroke as a densified sample chain through the panel's input node with a
success sentinel (a denied or failed panel write can never report a completed
gesture; a reboot-renumbered node re-probes). The pass at 3 px shows the
sample chain held the drag across its whole length on hardware.

## Reproduce

Open the app to its slider page, read the machine row, run the pan, read the
row again:

```sh
hdc -t 77TYD26826028730 shell "aa start -b com.stringzhao.captchaab -a EntryAbility"
node bin/agent-device.mjs press @e11 --platform harmonyos --serial 77TYD26826028730
node bin/agent-device.mjs gesture pan 165 1084 439 0 900 --platform harmonyos --serial 77TYD26826028730
node bin/agent-device.mjs snapshot --platform harmonyos --serial 77TYD26826028730 | grep 'ROUND='
```

The knob start position and the gap move per round; read both from a
screenshot before the drag.
