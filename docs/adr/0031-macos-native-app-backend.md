# ADR 0031: macOS Native App Backend — Accessibility Actions Beside XCTest

## Status

Accepted (2026-10-03). Opt-in; XCTest stays the default app-session backend.

## Rules at a glance

1. `AGENT_DEVICE_MACOS_APP_BACKEND` selects the backend for macOS `app` sessions: `xctest`
   (default) or `native`. It is a daemon setting read through `readMacOsAppBackend`: once by the
   Apple runtime owner, on its first macOS device, and once per macOS interactor. Other Apple
   devices never read it. An unknown value fails macOS sessions with `INVALID_ARGS`, never a
   silent fallback.
2. `macOsSurfaceBackend(surface, appBackend)` in `packages/contracts/src/session-surface.ts` is the
   one routing decision. With `native`, the `app` surface is helper-routed exactly like
   `frontmost-app`, `desktop`, and `menubar`.
3. A native daemon never starts XCTest on macOS. `macOsNativeBackendFacts` refuses every macOS
   operation only the runner serves (recording, `prepare`, `back`, press and hold, gestures and
   their viewport) at admission, for every macOS session, with `UNSUPPORTED_OPERATION` and
   `reason: 'unsupported-device-backend'`, the reason the physical-iOS XCTest backend uses.
   `macOsNativeAppInteractor` is assembled member by member, so no runner-backed member reaches
   it; an action that names no app is refused rather than handed to the runner.
4. Pointer actions are accessibility actions only: `AXPress`, focus, value, selected text, or a
   scroll bar value. Press and hold is refused at admission; double, secondary, and middle clicks
   are refused by the interactor before the helper runs. A press or fill with no pressable
   element, or a scroll with no settable scroll bar, is refused by the helper and carries its
   `helperReason` under the same `reason`; that vocabulary is pinned by
   `contracts/fixtures/macos-native-helper-outcomes.json`. Only keyboard text falls back to events
   posted to the app's process.
5. Snapshots of a Chromium-based session app (one shipping `chrome_100_percent.pak`) enable its
   accessibility tree (`AXManualAccessibility`, else `AXEnhancedUserInterface`) before traversal.
   Only the snapshot that turns the tree on waits for it (up to 1 s); a tree that does not
   populate adds a snapshot warning. The tree stays on for the app's lifetime, as for any
   assistive client. The app surface walks up to 48 levels deep and reports a deeper tree as
   truncated; other helper surfaces keep 12.
6. Screenshots capture the session app's front window by itself through ScreenCaptureKit.

## Context

The XCTest runner drives a macOS app through XCUIApplication, which puts the host in Automation
Mode: a system overlay is shown and the runner moves the shared pointer. The macOS helper already
read the accessibility tree for helper surfaces, and the session snapshot vocabulary is the same,
so an app session can be served without a test session while the app stays behind the user's
windows.

## Decision details

**Pointer delivery.** Events posted to a process with `CGEventPostToPid` were measured against
Calculator (SwiftUI): mouse events were dropped whether the app was frontmost or in the background,
and wheel events were dropped in the background, while every post reported success. Keyboard events
were accepted by Calculator and by Electron apps in the background. A fallback that cannot be
observed to work would turn "nothing happened" into success, so pointer actions have no event
fallback.

**Target resolution.** The helper hit-tests inside the session app (other apps' windows above it do
not answer) and walks at most four ancestors for a text input or a pressable control role.
Chromium answers a hit test with wrapper groups that all claim `AXPress`, so when the chain names
no control the helper picks the smallest such element whose frame contains the point, searching
only the window the hit landed in (the app's front on-screen window when the hit names none). A
group is pressed only when no control contains the point. Responses name the window acted in
(`windowTitle`) when the window has an accessibility title. This resolves the same point the daemon computed from the snapshot node; the
daemon dispatch paths and their ADR 0011 guarantees are unchanged.

**Pointer dispatch, not element identity.** The daemon dispatches every platform by point, and
the occlusion, offscreen, and parent-owned touch-point guarantees of ADR 0011 are decided on that
point. Sending an element identity instead would be a new dispatch path with its own guarantee
row, and an `AXUIElement` cannot outlive the one-shot helper process that resolved it, so an
identity would be a tree path re-resolved against a tree that may have changed.

## Rejected alternatives

- **Suppressing Automation Mode.** `automationmodetool` removes the authentication prompt, not the
  overlay, and the runner still owns the pointer.
- **Private SkyLight event delivery** (`SLEventPostToPid`, focus-without-raise). It would cover
  pointer-only controls, but it is private API that can break with any macOS release. Revisit only
  with evidence of apps the accessibility path cannot drive.
- **Native by default.** The accessibility path cannot express drags, holds, or double-clicks, and
  apps with sparse accessibility trees still need the runner. Defaults change only with coverage
  evidence across app frameworks.
