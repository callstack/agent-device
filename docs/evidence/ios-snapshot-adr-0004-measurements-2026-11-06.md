# iOS snapshot measurements from ADR 0004, 2026-11-06

These measurements moved out of [ADR 0004](../adr/0004-ios-snapshot-backend-strategy.md) on 2026-11-06.
Each item names the issue or PR that took it. The run details are in that issue.

## Quarter-turned keyboard window (#2612)

iPhone 17 Pro, iOS 26.2, system keyboard up over a landscape app frame `(0,0,874,402)`:

- `UIRemoteKeyboardWindow` reports `(0,0,402,874)`, the app's box with its side lengths swapped.
- The app window and `UITextEffectsWindow` both report `(0,0,874,402)`.

In portrait, the two spaces are the same.

## Placed iPad window (#3899)

iPad Pro 11-inch (M5), iOS 27.0, Calendar window at screen `(224,207,386x682)`:

- The root reads `(0,0,386,682)`.
- `Add` reads `(335,14,37,36)` but draws at `(559,221)`.
- The runner's live window read, the keyboard window, and a SpringBoard overlay report screen boxes.

Published as reported, the fold clipped nodes (`regular-node-outside-cumulative-clip`), and taps landed at the point minus the window origin.

## Modal containment (#2638)

React Navigation card-plus-modal example, three routes presented as sheets:

- Bridge: 567 nodes across three screens in one capture.
- Runner: 76 nodes, top screen only, for the same app state.
- Requesting `userInteractionEnabled` on every node increased capture time by about half on a 492-node tree. The targeted dimming-view read did not change capture time.
- At an undimmed detent, the bridge reports the dimming view as `userInteractionEnabled: false`. It reports `true` for the dimmed form sheet and the card modal. `XC_kAXXCAttributeIsVisible` reads false for both the undimmed sheet and the card modal.

## Visible-depth frontier removal (#2661)

Route: `snapshot --depth N`, recursive tier, 15 warm captures per cell, against `main` on the same simulator.

| Screen | Raw nodes | Presented nodes |
| --- | --- | --- |
| Form | 135 | 4 or 6 |
| Scrolled catalog list | 279 | 4 or 6 |

- Acquisition p50: within ±4 % of `main`, mixed sign.
- Acquisition p95: within ±7 % of `main`, mixed sign.

Both screens walked their whole raw tree. The platform materializes the `XCUIElementSnapshot` tree in one call, and that call is where acquisition time goes.

## Host process probe (#2751)

A host-side `pgrep` and `ps` probe before each capture cost each warm capture about 45 ms.

## Runner-served bridge (#4182)

Live captures on Limrun iOS 26.4 and on a local iOS 26.2 Simulator served trees from the runner's private reader queue.
