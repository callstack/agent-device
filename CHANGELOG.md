# Changelog

## Unreleased

- Breaking (ADR 0014, session ref-frame lifetime): a mutation through an `@ref` now expires the session's ref frame, so a later ref mutation without a fresh observation fails closed with a typed `details.reason` (`ref_frame_expired`, `ref_generation_mismatch`, `plain_ref_requires_complete_frame`, or `ref_not_issued`) instead of acting on a possibly-navigated screen. A ref-oriented sequence that performs several mutations must re-`snapshot` between them, consume an honestly issued `--settle` ref in pinned `@eN~s<gen>` form, or use selectors. Enforcement applies on every platform, not just iOS. Legacy hand-written `.ad` scripts that reuse several bare refs from one snapshot must capture between mutations or use selectors.
- Ref reads resolve against the authorized ref frame's source tree, so an internal read-only capture (including Android freshness) can no longer retarget an admitted `@ref` by positional coincidence. Read-only ref consumers keep the structured staleness warning while the frame retains the ref's evidence.

## 0.15.0

- Breaking: `apps` discovery and public app-list helpers now default to user-installed apps. Use `--all` or `filter: 'all'` to include system/OEM apps.
- Breaking: removed the `agent-device/android-apps` public subpath. Use the Android app helpers from `agent-device/android-adb`.
- Breaking: removed the `agent-device/daemon` public subpath. Use `agent-device/contracts` for daemon request/response types.
- Breaking: removed public local ADB bypass/selection helpers such as `spawnAndroidAdbBySerial` and `resolveAndroidAdbProvider`; use `createLocalAndroidAdbProvider(device)` or pass providers directly to the helpers from `agent-device/android-adb`.
- Added Android ADB provider helpers for exec, stream, clipboard, keyboard, app lifecycle, logcat, and port reverse workflows.
