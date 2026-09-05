# Known Limitations

Platform constraints that affect automation behavior.

## iOS: "Allow Paste" dialog suppressed under XCUITest

iOS 16+ shows an "Allow Paste" system prompt when an app reads `UIPasteboard.general` in the foreground. When an app is launched or activated through the XCUITest runner (which `agent-device` uses for iOS), the iOS runtime detects the testing context and silently grants pasteboard access — the prompt never appears.

This is an Apple platform constraint that affects all XCUITest-based automation tools.

**Workarounds:**

- **Pre-fill the pasteboard via simctl** — set clipboard content without triggering the dialog:
  ```bash
  echo "some text" | xcrun simctl pbcopy booted
  ```
- **Test the dialog manually** — the "Allow Paste" UX cannot be exercised through XCUITest-based automation.

## Android: non-ASCII text on real devices without the test IME helper

`adb shell input text` (the local ASCII-only fallback) cannot inject non-ASCII text (for example Chinese characters or emoji) on any Android system image. `agent-device` ships its own headless test IME (`android-ime-helper`) that handles this natively — it also removes the visible system keyboard from snapshots entirely, which the manual-ADBKeyBoard workaround this section used to describe never did.

- **Emulators**: the test IME activates automatically on `open`; non-ASCII `fill`/`type` just work, no setup needed.
- **Real devices**: pass `--test-ime` to `open` to opt in (off by default on real hardware, since a stuck helper IME leaves the real keyboard unavailable until restored — `agent-device` restores the previous IME on session close and on daemon startup if a prior session crashed, and `agent-device doctor` flags a stuck test IME with the exact `adb shell ime set <id>` command to fix it manually if needed).

If the helper cannot be installed (locked-down managed devices, some cloud providers), text entry falls back to the existing ASCII-only `adb shell input text` path and non-ASCII `fill`/`type` reports the gap.
