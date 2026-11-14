# HarmonyOS Trajectory Driver

A carrier HAP for `gesture pan --trajectory human` on HarmonyOS. It injects one want-parameterized
multi-point pointer trajectory through the platform test API
(`UiDriver.injectMultiPointerAction` with a `PointerMatrix`). Single focus: carry the injection,
nothing else.

## Why a test HAP

The SDK restricts the `@ohos.UiTest` injection APIs to testing directories
(`PointerMatrix` compiles only under `src/ohosTest`). Commercial HarmonyOS builds also deny the
shell user access to `/proc/bus/input/devices`, `/dev/input`, and `/sys/class/input`, so the raw
evdev transport cannot run there. The carrier rides the sanctioned test harness instead: the CLI
drives `aa test` with the trajectory JSON in a `-s` parameter, and the case injects it.

## Layout

- `entry/src/ohosTest/ets/test/TrajectoryInjection.test.ets` — the injection case. Reads the
  `traj` runner parameter, validates it, injects, and prints one `ADTRAJ_RESULT {json}` line on
  hilog tag `AdTrajDriver`.
- `entry/src/ohosTest/ets/testrunner/OpenHarmonyTestRunner.ets` — standard runner.
- `entry/src/main` — a plain carrier ability. No injection logic: the SDK forbids the UiTest APIs
  outside test directories.

Request shape (`-s traj`):

```json
{ "steps": [{ "x": 100, "y": 100 }, { "x": 160, "y": 140 }], "speed": 600 }
```

`speed` paces the whole stroke in px/s (200–40000). The platform recommends adjacent steps of
10–80 px; agent-device keeps the canonical sample geometry inside that budget where possible.

## Build

Toolchain: DevEco command-line tools (`hvigorw`, `ohpm`) and `DEVECO_SDK_HOME`.

```sh
cd examples/harmony-trajectory-driver
ohpm install
hvigorw assembleHap --mode module -p product=default --no-daemon       # carrier HAP
hvigorw assembleHap --mode module -p module=entry@ohosTest --no-daemon # test HAP (the injector)
```

Both HAPs build unsigned. Installing them needs a debug signature bound to
`com.stringzhao.adtrajdriver`.

## Install (debug-signed)

```sh
hdc -t <serial> install entry/build/default/outputs/default/entry-default-unsigned.hap  # signed first
hdc -t <serial> install entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap # signed first
```

`bm dump -n com.stringzhao.adtrajdriver` confirms the install; agent-device probes the same way
and caches the answer per device.

## Manual drive (smoke)

```sh
hdc -t <serial> shell aa test -b com.stringzhao.adtrajdriver -m entry_test \
  -s unittest OpenHarmonyTestRunner -s class adtraj_injectTrajectory \
  -s timeout 30000 \
  -s traj '{"steps":[{"x":540,"y":1600},{"x":540,"y":1300},{"x":548,"y":1240},{"x":540,"y":1300}],"speed":600}'
```

Expect `pass: adtraj_injectTrajectory` in the output and one
`ADTRAJ_RESULT {"ok":true,...}` hilog line on tag `AdTrajDriver`.

## Transport status (on-device comparison, 2026-11-04)

The carrier's injected touches reach system-layer windows (they scrolled the OS agreement page)
but do NOT trigger component-anchored gestures of ordinary app windows. Same slider, same
coordinates: `uitest uiInput swipe` triggered the ArkUI PanGesture 3/3 (pass at 350 px/s, a
mis-judged fail at 200 px/s - both prove the gesture fired), while the carrier injected 0/4
across shapes (2-point line, 41-point fine steps, 51-point burst at 40000 px/s).

agent-device therefore treats this carrier as an **experimental, explicit opt-in**: the CLI takes
the raw evdev sendevent transport first, and only `--trajectory-transport carrier` selects this
carrier when evdev is denied. Without either, `--trajectory human` refuses with
`trajectory-channel-unavailable` instead of reporting a green injection that moves nothing.

## AGC checklist (one-time, for a new bundle)

1. AGC console → My apps → Create app: package name `com.stringzhao.adtrajdriver`.
2. HarmonyOS app information: select the debug data protection as for other internal tools.
3. Users and permissions → Certificate/device: add the test device UDID to the debug profile.
4. Download the debug `.p12` + `.cer` + provision profile that list this bundle name.
5. Sign both HAPs (DevEco `signingConfigs` or `hdc`-side `hap-signer`), then install per above.
