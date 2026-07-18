# Changelog

## Unreleased

- Maestro compat: `assertVisible` and `assertNotVisible` now accept `childOf` for ancestor scoping, matching `tapOn` (#1294).
- Breaking: removed deprecated gesture duration and rotate velocity inputs (#1218).
  - `swipe x1 y1 x2 y2` no longer accepts a trailing `durationMs` positional; use `gesture pan x1 y1 (x2-x1) (y2-y1) durationMs` for deliberate timed drags.
  - Maestro `swipe` operations with a duration continue to normalize to `gesture pan` with the `endpoint-hold` execution profile, preserving the Maestro-compatible fast-swipe-then-hold behavior on iOS.
  - `gesture fling direction x y` no longer accepts a trailing `durationMs` positional; use `gesture pan` for timed movement.
  - `gesture swipe preset` no longer accepts a trailing `durationMs` positional; use `gesture pan` for timed movement.
  - `gesture rotate degrees [x] [y]` no longer accepts a trailing `velocity` positional; rotation pacing is derived from `degrees`.
  - MCP/Node schemas no longer advertise `velocity` or `durationMs` on `swipe`/`fling`/`gesture swipe`; `durationMs` remains on `gesture pan` and `gesture transform`.
- Breaking: the deprecated `rotate` CLI command alias has been removed. Use `orientation` instead; invoking `rotate` now fails with `rotate was renamed to orientation; for the two-finger gesture use: gesture rotate`.
- Breaking (ADR 0014, session ref-frame lifetime): a mutation through an `@ref` now expires the session's ref frame, so a later ref mutation without a fresh observation fails closed with a typed `details.reason` (`ref_frame_expired`, `ref_generation_mismatch`, `plain_ref_requires_complete_frame`, or `ref_not_issued`) instead of acting on a possibly-navigated screen. A ref-oriented sequence that performs several mutations must re-`snapshot` between them, consume an honestly issued `--settle` ref in pinned `@eN~s<gen>` form, or use selectors. Enforcement applies on every platform, not just iOS. Legacy hand-written `.ad` scripts that reuse several bare refs from one snapshot must capture between mutations or use selectors.
- Ref reads resolve against the authorized ref frame's source tree, so an internal read-only capture (including Android freshness) can no longer retarget an admitted `@ref` by positional coincidence. Read-only ref consumers keep the structured staleness warning while the frame retains the ref's evidence.

## 0.15.0

- Breaking: `apps` discovery and public app-list helpers now default to user-installed apps. Use `--all` or `filter: 'all'` to include system/OEM apps.
- Breaking: removed the `agent-device/android-apps` public subpath. Use the Android app helpers from `agent-device/android-adb`.
- Breaking: removed the `agent-device/daemon` public subpath. Use `agent-device/contracts` for daemon request/response types.
- Breaking: removed public local ADB bypass/selection helpers such as `spawnAndroidAdbBySerial` and `resolveAndroidAdbProvider`; use `createLocalAndroidAdbProvider(device)` or pass providers directly to the helpers from `agent-device/android-adb`.
- Added Android ADB provider helpers for exec, stream, clipboard, keyboard, app lifecycle, logcat, and port reverse workflows.
