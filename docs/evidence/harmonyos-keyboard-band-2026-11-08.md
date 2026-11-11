# HarmonyOS keyboard band fact, live, 2026-11-08 (fixed run 2026-11-09; z-order-only re-run 2026-11-10, head 2878b86e4)

Evidence for #4285 (report the keyboard band in snapshot responses), re-run at the
z-order-only head after review asked for the frame branch to go. The window-manager
table on this build never carries the key plane: the panel row reports the whole
display whether the keyboard shows or hides. The producer therefore reads only the
panel row's z-order and publishes visibility — it never publishes a frame, so the
0.9-share threshold (`DISPLAY_SPANNING_RECT_SHARE`) and the largest-rect display
derivation are gone: what they guarded against (a display-sized frame marking every
on-screen point keyboard-covered) cannot be constructed any more. This run
re-verifies the same facts at the new head. First fix: `2878b86e4`; simplification
follows the review question of 2026-11-10.

## Device

- HUAWEI 畅享 90 Plus, model `JUY-AL50` (`param get const.product.model`;
  the earlier revision of this file wrote `JDY-AL50`, which is a typo),
  HarmonyOS 7.0.0.111 (SP10C00E111R4P3), API 26
- Serial `77TYD26826028730`, USB
- Surface: system Settings → search field on the Settings home page, then the
  search page. One character typed by the in-band press, gone with the page
  (search-page state is transient). No user data read or written.

## What the window table actually holds

`hidumper -s WindowManagerService -a -a`, keyboard raised (Settings search field
focused). Both keyboard windows hold the full display rect; only the z-order
column moves:

```
softKeyboard1        0         6100    16    2105 102  0    103  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]
SCBKeyboardPanel     0         5714    17    2134 1    0    102  0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]
```

After one Back dismisses the IME, the same rows flip only in z-order:

```
softKeyboard1        0         6100    16    2105 102  0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]
SCBKeyboardPanel     0         5714    17    2134 1    0    -1   0           [ 0    0    1080 2406 ] [ 0       0       ] [ 1       1       0.5     0.5     ]
```

The key plane on this build sits at roughly y 1630–2325 in display pixels (the
keys-only crop below starts at y 1600); the IME window surface covers the display.
No public source reports that inner band: the window table carries window-surface
rects, and `hidumper -s InputMethodService -a '-a'` lists installed IMEs
(`小艺输入法`) with no geometry. A rect the table cannot prove smaller than the
display is the container, not a band — publishing one as `visible` made the tap
guard read every on-screen point as keyboard-covered (the `@e20` refusal in an
earlier revision of this file was that false refusal, presented as a feature).
The producer no longer reads the rect column at all: z-order decides visibility,
and the fact is always `visibility-only`.

## The fact through a raise and a dismiss (branch CLI, z-order-only head)

Settings home, keyboard hidden:

```json
"keyboard": {"kind": "visibility-only", "visible": false}
```

`press 540 381` on the search field raises the IME. The fact states visibility
and publishes no frame:

```json
"keyboard": {"kind": "visibility-only", "visible": true}
```

Keyboard raised, portrait (keys-only crop; the strip above it holds the app's
search page and is left out of the repo):

![keyboard keys with the IME raised](harmonyos-keyboard-band-keys-2026-11-09.jpg)

One Back hides the IME; the fact returns to `{"kind": "visibility-only",
"visible": false}`. A second Back then leaves the search page — the dismissal
choreography is one Back for the keyboard, one for the page, and the previous
revision's "two Back keys" line described the same two steps as one event.

## The guard at the new head

A ref captured with the keyboard up, pressed above the band, succeeds — this is
the class the display-spanning frame refused (`Ref @e20 is behind the visible
keyboard`):

```
$ agent-device press @e2 --platform harmonyos --serial 77TYD26826028730
Tapped @e2 (291, 192)
```

A bare coordinate press inside the band dispatches (the guard stays fail-open on
`visibility-only`; the press landed on a key and typed one character into the
transient search field):

```
$ agent-device press 540 1700 --platform harmonyos --serial 77TYD26826028730
Tapped (540, 1700)
```

## Probe cost

The probe is one `hidumper` round trip, measured 0.129 s alone on this device.
`snapshot --json` wall clock, three runs per CLI on the same page: with the probe
(built from #4285) 1.593 / 1.527 / 1.578 s; without it (a build from upstream
main) 1.976 / 1.437 / 1.495 s. Medians differ by 0.083 s, inside the run-to-run
spread; the first no-probe run shows the cold-start tail. The probe runs on every
HarmonyOS capture by design — every capture's keyboard feeds the snapshot state
later taps read.

## Landscape

Not run. The device exposes no public rotation channel — `uitest` has no rotate
subcommand, and agent-device's own `setHarmonyOrientation` answers
UNSUPPORTED_OPERATION on HarmonyOS — so the landscape run needs a physical
rotation this session cannot perform. The producer is orientation-independent by
construction: z-order does not depend on rotation, nothing derives from rect
geometry, and the real-row fixtures pin both states.

## Landing order

Proposed order in #4318 stands: #4292, #4290, #4293, #4287, then this PR, then
#4239. This PR lands fifth, rebased onto main (`b24ecf209`) with the snapshot
help conflict resolved.

## Reproduce

```sh
# z-order-only head, built in the PR worktree
node bin/agent-device.mjs open com.huawei.hmos.settings --activity com.huawei.hmos.settings.MainAbility \
  --platform harmonyos --serial 77TYD26826028730
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # visibility-only false
node bin/agent-device.mjs press 540 381 --platform harmonyos --serial 77TYD26826028730      # search field
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # visibility-only true, no frame
node bin/agent-device.mjs snapshot -i --json --platform harmonyos --serial 77TYD26826028730 # refs
node bin/agent-device.mjs press @e2 --platform harmonyos --serial 77TYD26826028730          # above band: succeeds
node bin/agent-device.mjs press 540 1700 --platform harmonyos --serial 77TYD26826028730     # in band: dispatches
node bin/agent-device.mjs back --platform harmonyos --serial 77TYD26826028730               # IME hides
node bin/agent-device.mjs snapshot --json --platform harmonyos --serial 77TYD26826028730   # visibility-only false
hidumper -s WindowManagerService -a -a   # on the device: the raw rows quoted above
```

CI cannot exercise a HarmonyOS device; this file is the device-side proof of the
z-order parse, the visibility-only fact, and the guard behavior.
