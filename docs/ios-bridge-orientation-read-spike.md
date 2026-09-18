# #2659 spike: can the Simulator AX bridge guest read the app's interface orientation?

Time-boxed spike, 2026-09-18, on iPhone 17 Pro (iOS 26.2 Simulator, UDID
5AF10197-87C1-4799-835E-3C6CBF9F3163), macOS host with Xcode 26.2. The one
question: **can the Simulator AX bridge guest learn the foreground app's
`UIInterfaceOrientation` (1 portrait, 2 upside-down, 3 landscape-right, 4
landscape-left) cheaply and reliably at capture time**, so the bridge can
normalize a quarter-turned subtree the way the runner does and the
detection-only layer from PR #2653 comes out.

Method: throwaway Objective-C guests compiled exactly like the bridge
(`xcrun --sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=15.0
-fobjc-arc`), spawned with `xcrun simctl spawn <udid> <bin> <app-pid>`, that
dlopen the same `AXRuntime` / `XCTAutomationSupport` the bridge dlopens and read
orientation through each candidate route. Orientation was forced with
`agent-device orientation <portrait|landscape-left|landscape-right>` (which drives
`XCUIDevice.shared.orientation` and asserts the observed device orientation),
so each reading is taken on a screen whose orientation is known. The subject app
is `com.callstack.agentdevicelab` (`examples/test-app`, supports all four
orientations). None of this probe code is merged; the essential source is in the
Appendix.

## Verdict

**No.** No route gives the app's `UIInterfaceOrientation` cheaply *and* reliably
from the guest. The attribute the spike hoped for exists and resolves, but the
guest's snapshot channel returns 0 for it and XCTest's own reader errors out;
the one cheap service read returns the *device* orientation, which is the wrong
quantity and provably diverges from the app's interface orientation. The
detect-and-refuse layer #2653 added on the bridge side, and the ADR 0004 "refuse
the screen" decision, stay. The delete-the-layer follow-up plan is **not**
unlocked.

## Route 1 — an AX attribute in the bridge's own vocabulary

Candidate names were fed through the same resolver the bridge already uses,
`XCAXAccessibilityAttributesForStringAttributes`, one name at a time:

| name | resolves? | attribute id |
|---|---|---|
| `XC_kAXXCAttributeApplicationOrientation` | yes | **1503** |
| `XC_kAXXCAttributeOrientation` | no | -1 |
| `XC_kAXXCAttributeInterfaceOrientation` | no | -1 |
| `XC_kAXXCAttributeFrame` (control) | yes | 2003 |

The string `XC_kAXXCAttributeApplicationOrientation` is real in
`XCTAutomationSupport`'s table, next to `appOrientationForElement:error:` and
"Fetching application interface orientation". So a name exists. The value does
not reach the guest:

- Requesting attribute 1503 in `userTestingSnapshotForElement:options:error:` —
  the exact call the bridge uses — returns **0 (`UIInterfaceOrientationUnknown`)**
  on the `UIApplication` root and on every window, in portrait, landscape-left,
  and landscape-right, while the sibling `...Frame` attribute in the *same*
  snapshot correctly reports `(0,0,402,874)` in portrait and `(0,0,874,402)` in
  landscape. The snapshot channel knows the geometry but not the orientation.

- XCTest's own reader `-[XCTAccessibilityFramework appOrientationForElement:error:]`
  — the very class the bridge instantiates via `initForRemoteAccess` — fails from
  a guest: with the pid's `XCAccessibilityElement` it returns `0` and
  `Error getting app orientation kAXErrorServerNotFound`; with the raw
  `AXUIElement` it returns `0` with no error. The runner reads a real value only
  because it holds a live XCUIApplication session; the bridge's remote-access
  channel cannot ask for that attribute and get it back.

Per-read cost was irrelevant (the failing reads run in ~0.04 ms) because no value
is produced.

## Route 2 — inference from the tree already captured

Reached only because routes 1 and 3 (checked first, in cheapness order) returned
no fact. The signal route 2 would use is present and matches the fixture: in
landscape the app's own `UIWindow`/`UITextEffectsWindow` report `(0,0,874,402)`
while `UIRemoteKeyboardWindow` (and, in the same capture, `UIInputSetContainerView`)
report the quarter-turned `(0,0,402,874)`. That says "some surface arrived turned"
but not "the app is at interface orientation N": it is an assumption about docked
keyboards, it is blind with no keyboard up, it cannot name an arbitrary rotated
surface, and it cannot tell portrait from portrait-upside-down. Fallback material
only, and weaker than routes 1 and 3 precisely because those were checked first
and a heuristic is all that is left once they return no fact.

## Route 3 — a SpringBoard / BackBoard service call

Symbols checked with `nm -gU` on the iOS 26.2 Simulator runtime binaries and
confirmed with `dlopen`/`dlsym` from inside the guest.

- **SpringBoardServices**: `SBSGetActiveInterfaceOrientation` is not exported
  under that C name. `SBGetInterfaceOrientation` and the MIG
  `_SBSGetActiveInterfaceOrientation` resolve, but called as `long (void)` they
  return a fixed **`0x10000003`** in every orientation — not a
  `UIInterfaceOrientation`. Usable as-is: no.
- **BackBoardServices**: `BKHIDServicesGetCurrentDeviceOrientation` works and is
  cheap — median **0.014–0.015 ms** over 11 warm reads (≈ a cached read, far
  below a Mach round trip). It tracks the **device** orientation
  (`UIDeviceOrientation`), not the app's interface orientation.

What the guest actually measures, beside the foreground app's own root window in
the same capture:

| screen (set via the runner) | device read `BKHIDServices…` | test-app root window |
|---|---|---|
| portrait | 1 | `(0,0,402,874)` |
| device landscape-left | 3 | `(0,0,874,402)` |
| device landscape-right | 4 | `(0,0,874,402)` |

The test-app supports every orientation and autorotates, so its *interface*
orientation is the mirror of the device orientation, and because
`UIDeviceOrientation` and `UIInterfaceOrientation` give the mirrored landscape pair
the same integers (device landscapeLeft 3 ↔ interface landscapeRight 3; device
landscapeRight 4 ↔ interface landscapeLeft 4), the device integer happens to equal
the runner's `interfaceOrientation` integer here. (The interface integer is that
documented mapping, not a value the spike printed — no host surface exposes the
runner's read; the window column is the measured geometry, which cannot tell
landscape-left from landscape-right on its own.) It reads the wrong quantity, and
that bites:

- With a **rotation-locked** app foreground — `com.apple.Preferences`, whose root
  reports `SwiftUIApplication` — and the device rotated to landscape-left, the
  device read is **3** while the app's root window stays portrait
  **`(0,0,402,874)`**. The device is landscape; the foreground app's interface is
  portrait. A bridge that fed 3 into the rotation table would turn a portrait
  screen that never turned.

So route 3's only working read is device orientation, which is not the app's
interface orientation and cannot be made to be from a guest (UIKit keeps
per-app interface orientation inside the app's own process, which is exactly why
the runner reads it with a live session).

## What this changes

Nothing merges from the spike. The bridge's detect-and-refuse layer #2653 added
stays, because the question it answers — "is this subtree quarter-turned and can I name the
orientation to turn it back?" — still has a "no, and I cannot cheaply name it"
answer on the guest side. The ADR 0004 amendment "A producer that cannot name the
app's interface orientation refuses the screen" is now backed by measurements
rather than by the absence of a check.

If a future attempt wants to unlock the delete-the-layer plan, the bar is a guest
read that (a) survives a rotation-locked foreground app and (b) names the
*foreground app's* interface orientation, not the device's. Route 1's attribute is
the right handle to keep an eye on — if a future bridge ever populates 1503 in the
snapshot the way the runner reads it, `tree.ts` could port
`CoordinateSpaceRotation.oriented(rect:in:interfaceOrientation:)`, pin it against the fixture's
`rotationCases`, and retire `isQuarterTurnedWindowFrame`,
`unresolvedCoordinateSpaceWindows`, `window-coordinate-space-unresolved`, and the
ADR 0004 refusal decision. That handle does not work today.

## Out of scope / not covered

- **Physical devices.** The AX bridge is Simulator-only; nothing here speaks to
  the `usbmux`/`network` runner path.
- The runner's literal `interfaceOrientationForApplication:` integer was not read
  from the host side — no command or snapshot field exposes it. Interface-space
  truth was witnessed by the captured window geometry and by the rotation-locked
  Settings divergence above, not by a printed runner value.
- A rotation-locked *React Native* app was not measured directly; `examples/test-app`
  autorotates, so it cannot itself show the device/interface split. The Settings
  case demonstrates that class of divergence on a system app.
- `SBGetInterfaceOrientation` was called as `long (void)`; a display-id or
  out-param signature was not chased, but its constant return across three known
  orientations rules it out as a plain interface-orientation source regardless.

## Appendix — throwaway probe (not merged)

`probe.m` spawned via `xcrun simctl spawn <udid> probe <pid>`; the load-bearing
pieces:

```objc
// Route 1: resolve the name the bridge's own resolver understands.
AttributeNumbersForNamesFn attrForNames = dlsym(RTLD_DEFAULT, "XCAXAccessibilityAttributesForStringAttributes");
// attrForNames(@[@"XC_kAXXCAttributeApplicationOrientation"]) -> @[1503]

// Route 1: read it back off the app-root snapshot (same call the bridge uses).
// attributes=[1503,2003], maxDepth=1 -> root attributes[@1503] == 0 in every orientation.

// Route 1: XCTest's own reader, same class the bridge instantiates.
SEL ao = NSSelectorFromString(@"appOrientationForElement:error:");
long v = ((long(*)(id,SEL,id,NSError**))objc_msgSend)(framework, ao, elementOrRaw, &err);
// element -> 0 + kAXErrorServerNotFound; raw -> 0.

// Route 3: the cheap device-orientation read (device space, not interface space).
void *bbs = dlopen(".../BackBoardServices.framework/BackBoardServices", RTLD_NOW);
long(*get)(void) = dlsym(bbs, "BKHIDServicesGetCurrentDeviceOrientation");   // portrait=1, LL=3, LR=4
```

Force the screen with the built CLI against an isolated state dir, then read:

```bash
agent-device orientation landscape-left --session spikesess --platform ios --udid <udid> --state-dir <dir>
xcrun simctl spawn <udid> .../probe <app-pid>
```

Symbol discovery that shaped the candidates (host-side):

```bash
RR="/Library/Developer/CoreSimulator/Volumes/iOS_23C54/.../iOS 26.2.simruntime/Contents/Resources/RuntimeRoot"
strings -a "$RR/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework/XCTAutomationSupport" | grep -i orientation   # -> XC_kAXXCAttributeApplicationOrientation
nm -gU "$RR/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices" | grep -i orient               # -> SBGetInterfaceOrientation, _SBSGetActiveInterfaceOrientation
nm -gU "$RR/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices"    | grep -i orient               # -> BKHIDServicesGetCurrentDeviceOrientation
```
