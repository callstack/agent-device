# HarmonyOS gesture pan transport correction, 2026-11-12

Evidence for #4239: this file corrects and replaces
`harmonyos-trajectory-slider-2026-11-08.md` (deleted from the head). The 11-08
run drove the slider through the uiInput endpoint swipe and its oracle passed,
but the file presented that pass as evidence of the panel-evdev trajectory
chain. It was not: the run omitted `--json`, so it could not name the executed
route, and the only available device denies every input node, so the
trajectory chain could not have executed. The slider oracle also passes on the
plain swipe, so it cannot separate the two transports by construction.

## The device denies the input nodes

- HUAWEI 畅享 90 Plus, model `JDY-AL50`, HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB, `hdc shell` as uid 2000 (shell)

```sh
$ hdc -t 77TYD26826028730 shell "id; cat /proc/bus/input/devices; ls -l /dev/input/"
uid=2000(shell) gid=2000(shell) groups=2000(shell),1006(file_manager),1007(log),1097(netsys_socket),3009(readproc) context=u:r:sh:s0
/bin/sh: cat: /proc/bus/input/devices: Permission denied
ls: /dev/input/: Permission denied
```

The listing is denied at uid 2000, so the transport resolver answers
`touch-node-listing-unreadable` on this device and every pan takes the
endpoint swipe. The .109 build showed the same denial. No run on this device
can ever reach the panel node, and the existence and argument order of
`uinput sendevent` remain unverified on HarmonyOS.

## What the command reports at the reshaped head

With the sendevent route dropped, the pan reports its one real transport
verbatim (`agent-device` head `740ae321c`, the sources this correction builds;
surface
`com.stringzhao.captchaab`, slider-puzzle page, round 2 fresh
(`ROUND=2 RESULT=NONE`), knob at the track's left edge over track center
y=1066, puzzle gap scored 525 px right of the knob):

```json
{
  "kind": "pan",
  "durationMs": 900,
  "pointerCount": 1,
  "from": { "x": 167, "y": 1066 },
  "to": { "x": 692, "y": 1066 },
  "backend": "harmonyos-hdc-uiinput",
  "command": "swipe",
  "velocity": 583,
  "viewport": { "x": 0, "y": 108, "width": 1080, "height": 2298 },
  "executionProfile": "timed-pan",
  "message": "Panned (167, 1066) by (525, 0)"
}
```

The machine-readable verdict row after the pan:

```
ROUND=2 RESULT=PASS DETAIL=offset=2px tol=20 PASS=2 FAIL=0 TYPE=slider
```

This pass evidences the endpoint swipe route — the only one this hardware
exposes. It says nothing about a densified sample chain, because no sample
chain runs on this build.

## Consequence for the PR

The sendevent trajectory route is dropped until a device with a readable
input listing exists. The densify loop the route would have shared moves to
`densifyGesturePath` in `packages/contracts/gesture-plan.ts` with Android's
`lowerAndroidTouchPlan` as its caller, so the sampled-path rule keeps one
owner. The PR no longer claims a trajectory backend for HarmonyOS pan; the
command's `--json` names `harmonyos-hdc-uiinput` and reports no fallback
field, because there is nothing left to fall back from.
