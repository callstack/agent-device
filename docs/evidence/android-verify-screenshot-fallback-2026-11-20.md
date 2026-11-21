# Android `--verify` screenshot fallback through the full-screen-container exemption, 2026-11-20

Evidence for #4297 at the gate-exemption head `28c408b94`. Device: Redmi
K60 (`2312DRAABC`, MIUI Android 14, 1080x2400), Edge (`com.microsoft.emmx`)
serving the local rig page over `adb reverse tcp:8642`, backend
`android-helper` (`snapshotQuality.backend: "android-helper"`). The battery
level was forced to 37 with `adb shell dumpsys battery set level 37` about
400 ms into the press and reset right after, so the only candidate change
besides the page itself was the status-bar glyph.

## The tree that used to close the gate, and the exemption that opens it

Interactive snapshot at the rig page (23 nodes; header rows trimmed):

```json
{"ref": "e1", "type": "android.webkit.WebView", "hittable": true,
 "rect": {"x": 0, "y": 237, "width": 1080, "height": 1976}},
{"ref": "e3", "type": "android.widget.Button", "hittable": true,
 "rect": {"x": 385, "y": 253, "width": 310, "height": 143}, "label": "TAB A"},
{"ref": "e4", "type": "android.widget.TextView", "hittable": null,
 "rect": {"x": 0, "y": 237, "width": 1080, "height": 654}, "label": "static body"}
```

No window or application node exists (Android emits none), so the point's
resolved viewport comes from `resolveViewportRect`'s largest-containing-rect
fallback. At the dead point `(540, 1500)` the only covering hittable node
is the WebView container, and its rect IS the resolved viewport — the
option-(a) exemption admits the pair. Under the pre-exemption gate this
same tree and point produced tree evidence with no `screenshotDiff` (the
gate closed on every real point).

## Run 1 — dead tap with a forced status-bar change

`press 540 1500 --verify --json` on the rig's dead area, battery forced
mid-dispatch:

```json
{
  "success": true,
  "data": {
    "x": 540,
    "y": 1500,
    "message": "Tapped (540, 1500)",
    "targetKind": "point",
    "evidence": {
      "digest": "ax1:f017ea1bdbba74a8",
      "nodeCount": 23,
      "interactiveNodeCount": 23,
      "foregroundApp": "com.microsoft.emmx",
      "changedFromBefore": false,
      "screenshotDiff": {
        "changedFromBefore": false,
        "changedPixelRatio": 0
      }
    }
  }
}
```

`changedFromBefore: false`, ratio 0 — the forced change landed between the
frames (the battery read 37 during the window and 100 again after the
reset), the 4% portrait band excluded it, and the outside-the-status-bar
comparison saw an identical frame. A post-run screenshot shows the status
bar back at 100% and the page unchanged.

A second dead run on the MIUI launcher (`com.miui.home`, `press 540 700
--verify --json`, same forced change) read the same shape:
`changedFromBefore: false`, `screenshotDiff {false, 0}`, tree digest
`ax1:36d6f2391b33939c`.

## Run 2 — a tap that redraws custom-drawn content

The rig page's second version carries a 280x180 canvas (a plain drawn
surface the tree reports as a hittable-less `android.widget.Image` at
`154,391 772x495` with no semantics). `press 540 638 --verify --json`
taps it; its click handler repaints the canvas gray→red and rewrites the
state row:

```json
{
  "success": true,
  "data": {
    "x": 540,
    "y": 638,
    "message": "Tapped (540, 638)",
    "targetKind": "point",
    "evidence": {
      "digest": "ax1:8832c6a9aa185a47",
      "nodeCount": 23,
      "interactiveNodeCount": 23,
      "foregroundApp": "com.microsoft.emmx",
      "changedFromBefore": true,
      "screenshotDiff": {
        "changedFromBefore": true,
        "changedPixelRatio": 0.15493023405349796
      }
    }
  }
}
```

Aggregate true with `screenshotDiff {changedFromBefore: true,
changedPixelRatio: 0.155}`. A post-run screenshot shows the canvas red with
`STATE=RED`, matching the pixel answer.

## Notes

- Backend: `android-helper` (snapshot helper 0.21.42-dev, built from this
  tree); screenshots go through the helper's capture with
  `rotationFacts(device, ...)` declaring the band.
- The tap at `(540, 638)` covers one non-blocking candidate (`e3` shape on
  the first rig: the WebView only). On the second rig the canvas node is
  not hittable and names no touch role, so the gate stays open there too.
- Battery reset and status bar restored after the runs; the rig server was
  an unrelated loopback process, left running for reproduction.
