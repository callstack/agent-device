# ADR 0031: macOS Native App Backend — Accessibility Actions Beside XCTest

## Status

Accepted (2026-10-03). Opt-in; XCTest stays the default app-session backend.

## Rules at a glance

1. `AGENT_DEVICE_MACOS_APP_BACKEND` selects the backend for macOS `app` sessions: `xctest`
   (default) or `native`. It is read from the daemon's environment through `readMacOsAppBackend`,
   once per Apple interactor; an unknown value is `INVALID_ARGS`, never a silent fallback.
2. `macOsSurfaceBackend(surface, appBackend)` in `packages/contracts/src/session-surface.ts` is the
   one routing decision. With `native`, the `app` surface is helper-routed exactly like
   `frontmost-app`, `desktop`, and `menubar`; every caller passes the backend explicitly.
3. An app session never starts XCTest. Commands only the runner serves (`back`, `home`,
   `orientation`, `app-switcher`, drag gestures and their viewport, keyboard dismiss/enter) refuse
   with `UNSUPPORTED_OPERATION` and `reason: 'macos-native-backend-unsupported'`. Calls that name
   no app, and presses on another surface, keep their XCTest-backend owner
   (`withMacOsNativeAppBackend`). The explicit `prepare` command still starts the runner.
4. Pointer actions are accessibility actions only: `AXPress`, focus, value, selected text, or a
   scroll bar value. A pointer action with no accessibility equivalent (double-click, press and
   hold, no pressable element, no settable scroll bar) is refused with the helper's typed
   `helperReason`; the vocabulary is pinned by `contracts/fixtures/macos-native-helper-outcomes.json`.
   Secondary and middle clicks are refused by the interactor itself and carry no `helperReason`.
   Only keyboard text falls back to events posted to the app's process.
5. Snapshots of a Chromium-based session app (one shipping `chrome_100_percent.pak`) enable its
   accessibility tree (`AXManualAccessibility`, else `AXEnhancedUserInterface`) before traversal.
   The tree stays on for the app's lifetime, as for any assistive client. The app surface walks up
   to 48 levels deep and reports a deeper tree as truncated; other helper surfaces keep 12.
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
not answer), walks at most four ancestors for a text input or a pressable control role, and
otherwise picks the smallest such element whose frame contains the point. Chromium answers a hit
test with wrapper groups that all claim `AXPress`, so a group is pressed only when no control
contains the point. This resolves the same point the daemon computed from the snapshot node; the
daemon dispatch paths and their ADR 0011 guarantees are unchanged.

## Rejected alternatives

- **Suppressing Automation Mode.** `automationmodetool` removes the authentication prompt, not the
  overlay, and the runner still owns the pointer.
- **Private SkyLight event delivery** (`SLEventPostToPid`, focus-without-raise). It would cover
  pointer-only controls, but it is private API that can break with any macOS release. Revisit only
  with evidence of apps the accessibility path cannot drive.
- **Native by default.** The accessibility path cannot express drags, holds, or double-clicks, and
  apps with sparse accessibility trees still need the runner. Defaults change only with coverage
  evidence across app frameworks.
