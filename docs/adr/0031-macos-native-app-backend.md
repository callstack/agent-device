# ADR 0031: macOS Native App Backend — Accessibility Actions Beside XCTest

## Status

Accepted (2026-10-03). Native is opt-in; XCTest remains the default app-session backend.
Pointer event delivery was measured again on 2026-10-05 (#3213).
Electron, Catalyst, and wheel delivery with window fields remain unmeasured.

## Rules at a glance

1. `AGENT_DEVICE_MACOS_APP_BACKEND` selects `xctest` (default) or `native` for macOS `app` sessions.
   `readMacOsAppBackend` reads this daemon setting once for the Apple runtime owner's first macOS device and once per macOS interactor.
   Other Apple devices never read it.
   Unknown values fail macOS sessions with `INVALID_ARGS`, without silent fallback.
2. `macOsSurfaceBackend(surface, appBackend)` in `packages/contracts/src/session-surface.ts` owns the single routing decision.
   With `native`, the `app` surface is helper-routed exactly like `frontmost-app`, `desktop`, and `menubar`.
3. A native daemon never starts XCTest on macOS.
   For every macOS session, `macOsNativeBackendFacts` refuses every runner-only operation at admission:
   - Recording.
   - `prepare`.
   - `back`.
   - Press and hold.
   - Gestures and their viewport.
   Refusal uses `UNSUPPORTED_OPERATION` with `reason: 'unsupported-device-backend'`, as the physical-iOS XCTest backend does.
   `macOsNativeAppInteractor` is assembled member by member, so no runner-backed member reaches it.
   Actions without a named app are refused instead of sent to the runner.
4. Pointer actions use only accessibility: `AXPress`, focus, value, selected text, or scroll bar value.
   Admission refuses press and hold.
   Before helper execution, the interactor refuses double, secondary, and middle clicks.
   The helper refuses press/fill without a pressable element and scroll without a settable scroll bar.
   It supplies `helperReason` under the same `reason`.
   `contracts/fixtures/macos-native-helper-outcomes.json` pins this vocabulary.
   Only keyboard text falls back to events posted to the app process.
5. Before traversal, snapshots enable Chromium session-app accessibility through `AXManualAccessibility`, or `AXEnhancedUserInterface` if necessary.
   A shipped `chrome_100_percent.pak` identifies these apps.
   Only the snapshot that enables the tree waits for it, for at most 1 s.
   If the tree does not populate, the snapshot adds a warning.
   The tree remains enabled for the app lifetime, as with any assistive client.
   App-surface traversal walks at most 48 levels deep and reports deeper trees as truncated.
   Other helper surfaces retain 12 levels.
6. Screenshots capture only the session app's front window through ScreenCaptureKit.

## Context

XCTest drives a macOS app through XCUIApplication and puts the host in Automation Mode.
Automation Mode shows a system overlay.
The runner moves the shared pointer.
The macOS helper already reads accessibility trees for helper surfaces with the same session snapshot vocabulary.
It can therefore serve an app session without a test session while the app remains behind the user's windows.

## Decision details

**Pointer delivery.**
Initial `CGEventPostToPid` measurements used Calculator (SwiftUI) without window fields.
Mouse events were dropped in foreground and background.
Wheel events were dropped in background.
Every post still reported success.

A second background measurement used AppKit, SwiftUI, and WKWebView fixtures (#3213).
Window fields, not the API choice, determined delivery.
The target window number occupied event field 51.
Either field 58 or window-local `CGEventSetWindowLocation` supplied the remaining context.
Public `CGEventPostToPid` delivered clicks, double-clicks with field 1 click state, and secondary clicks to all three fixtures.
All 54 of 54 cases succeeded without app activation or frontmost-app change.
Fields 51 and 58 are undocumented.
Drags and WKWebView button clicks arrived only after private focus-without-raise activation.
Calculator and Electron accepted background keyboard events.

A dropped post still reports success.
An unverified event fallback would therefore report success when no action occurred.
Pointer actions have no event fallback until an event path verifies its outcome.

**Target resolution.**
The helper acts only inside the session app's own on-screen windows, including menus and sheets.
It never acts on the app menu bar.
The Apple menu affects the complete Mac through Sleep, Lock Screen, and Recent Items.
Other points are refused with `no-accessible-target`.
The helper hit-tests only the session app.
Other apps' overlaid windows do not answer.
It traverses at most four ancestors for a text input or pressable control role.

Chromium hit tests return wrapper groups that all claim `AXPress`.
If the chain names no control, the helper selects the smallest such element whose frame contains the point.
The search covers only the hit window.
If the hit names no window, it uses the app's front on-screen window.
A group is pressed only if no control contains the point.
If the window has an accessibility title, the response reports it as `windowTitle`.
This resolves the same point computed from the snapshot node.
Daemon dispatch paths and their ADR 0011 guarantees remain unchanged.

**Pointer dispatch, not element identity.**
Daemon dispatch uses points on every platform.
ADR 0011 occlusion, offscreen, and parent-owned touch-point guarantees apply to that point.
Element identity would create a new dispatch path with its own guarantee row.
An `AXUIElement` cannot outlive the one-shot helper that resolves it.
An identity would therefore be a tree path resolved again against a possibly changed tree.

**Ghost cursor.**
Each helper action draws a separate pointer.
It moves to the target from a short fixed offset and pulses on delivery.
A person can follow the agent without losing the real pointer.
This costs approximately 0.3 s per action and retains no state between helper processes.
A persistent pointer would require a long-lived helper.
`AGENT_DEVICE_MACOS_GHOST_CURSOR=0` disables the ghost cursor.

## Rejected alternatives

- **Suppress Automation Mode.**
  `automationmodetool` removes the authentication prompt, not the overlay.
  The runner still controls the pointer.
- **Private SkyLight events through `SLEventPostToPid` or focus-without-raise.**
  `SLEventPostToPid` delivered no additional events beyond public `CGEventPostToPid` with the same fields (#3213).
  Focus-without-raise through `SLPSPostEventRecordTo` made the target AppKit-active while the frontmost app retained user keystrokes.
  Only this approach delivered drags to the fixture.
  However, the private API can break in any macOS release.
- **Native by default.**
  Accessibility cannot express drags, holds, or double-clicks.
  Apps with sparse accessibility trees still require the runner.
  Defaults change only with coverage evidence across app frameworks.
