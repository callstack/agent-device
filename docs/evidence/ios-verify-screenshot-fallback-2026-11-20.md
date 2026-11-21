# iOS `--verify` screenshot fallback on the custom-drawn canvas fixture, 2026-11-20

Evidence for #4297 at the gate-exemption head `28c408b94` (the only later
commit is this docs change). The runner fixture is the source-built
unit-test runner (`AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1`), installed
on the iPhone 17 Pro Max simulator (`F8658A47-112D-48F1-8D18-226A74F39689`,
iOS 26.5, Xcode 27.2) and launched with `--agent-device-custom-drawn-canvas`
through `open --launch-args`. The fixture adds a 160x160 plain UIView the
accessibility tree never exposes: a tap toggles its fill between systemGray5
and systemRed.

## Pre-action tree: no hittable or semantic node covers the canvas point

Full snapshot at the session app:

```json
[
  {"index": 0, "type": "Application", "role": "UIApplication", "label": "AgentDeviceRunner",
   "rect": {"x": 0, "y": 0, "width": 440, "height": 956}, "enabled": true, "depth": 0,
   "pid": 92141, "hittable": false, "ref": "e1", "kind": "application"},
  {"index": 1, "parentIndex": 0, "type": "StaticText", "role": "UILabel",
   "label": "Agent Device Runner",
   "rect": {"x": 120.0, "y": 465, "width": 200.3, "height": 26.3}, "enabled": true,
   "depth": 1, "pid": 92141, "hittable": true, "ref": "e2", "kind": "text"}
]
```

The canvas (roughly 140..300 x 611..771 pt, centered under the label) names
no element: the point `(220, 720)` is covered only by the Application node
itself (the viewport root, not hittable). The StaticText does not cover it.
The tree-coverage gate has no covering touch target to block on, so the
pixel pair is admitted and the screenshot fallback runs.

## Run 1 — status-bar-only change between the frames

`press 220 720 --verify --json` is a canvas tap; to make the only other
candidate change a status-bar glyph, the simulator's battery level was
forced to 37 about 500 ms into the press (`xcrun simctl status_bar
override --batteryLevel 37`) and cleared right after. The band (6% of the
portrait frame, declared by the apple capture owner) excludes that region,
so the forced change must not surface:

```json
{
  "success": true,
  "data": {
    "x": 220,
    "y": 720,
    "message": "Tapped (220, 720)",
    "runnerMainThreadBusy": false,
    "targetKind": "point",
    "evidence": {
      "digest": "ax1:aaf591869124d41c",
      "nodeCount": 3,
      "interactiveNodeCount": 2,
      "changedFromBefore": false,
      "screenshotDiff": {
        "changedFromBefore": false,
        "changedPixelRatio": 0
      }
    }
  }
}
```

Aggregate `changedFromBefore` is false (no comparison verification saw a
change) and the pixel-only answer is `screenshotDiff {changedFromBefore:
false, changedPixelRatio: 0}` — the forced status-bar redraw landed inside
the excluded band and the outside-the-status-bar comparison saw an
identical frame.

## Run 2 — a tap that redraws the canvas

`press 220 720 --verify --json` again, this time with no status-bar
override. The tap lands on the custom-drawn view and toggles its fill:

```json
{
  "success": true,
  "data": {
    "x": 220,
    "y": 720,
    "message": "Tapped (220, 720)",
    "runnerMainThreadBusy": false,
    "targetKind": "point",
    "evidence": {
      "digest": "ax1:aaf591869124d41c",
      "nodeCount": 3,
      "interactiveNodeCount": 2,
      "changedFromBefore": true,
      "screenshotDiff": {
        "changedFromBefore": true,
        "changedPixelRatio": 0.06512286378804732
      }
    }
  }
}
```

Aggregate true with `screenshotDiff {changedFromBefore: true,
changedPixelRatio: 0.0651}` — the canvas (160/440 x 160/956 ≈ 6.1% of the
frame) turned red, and the ratio matches that share.

## Notes

- Backend: XCTest runner (source build with the unit-test fixture define),
  session app `com.callstack.agentdevice.runner` (pid 92141 at snapshot).
- The capture binding is the production one: the daemon's
  `createVerifyScreenshotCapture` binds the screenshot lane for the session
  (`captureScreenshotFromRequest` with the session surface, fullscreen for
  a portrait iOS target) — no flag route, no test-injected capture.
- The iOS dead-region run at `(60, 820)` (left margin, no node under it)
  with the same forced battery change read `changedFromBefore: false` with
  `screenshotDiff {false, 0}` as well.
- Status bar cleared after the runs; the simulator was left booted.
