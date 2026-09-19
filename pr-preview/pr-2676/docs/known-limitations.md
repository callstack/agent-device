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

## Android: first helper install can wait on an OEM install dialog

Some OEM builds gate the first install of a package behind the system package installer and keep `adb install` open until someone confirms it on the device screen. That applies to both `agent-device` helper APKs (the snapshot helper and the test IME), one time per package: on ColorOS, reported on an OPPO Find N6, the first install needs two taps — confirm the install, then dismiss the completion screen — and every later install of the same package is silent.

An unattended first Android snapshot therefore times out with a helper install failure whose hint says to check the device screen for a pending install confirmation. Confirm the prompts on the device and retry; if no dialog is showing, restart the ADB server as the hint says.

## Android: no clipboard access over adb on Android 16

`agent-device` reaches the Android clipboard through `adb shell cmd clipboard`. That command works only on a build whose clipboard service implements a shell command, and AOSP's `ClipboardService` does not: the class carries no shell command at `android13-release`, `android14-release`, `android15-release` or `android16-release`, nor on current AOSP `main`, and a physical device runs that same class. On Android 16 (API 36) every `cmd clipboard get text` and `cmd clipboard set text <text>` call is answered by the framework's default `Binder.handleShellCommand` — `No shell command implementation.` on stderr, exit status **0** — so the clipboard is never touched even though the call reports success.

`agent-device` asks each device once whether its clipboard service answers, and refuses rather than repeating that silence:

- `capabilities` omits `clipboard` on such a device;
- `clipboard read` and `clipboard write` fail with `UNSUPPORTED_OPERATION` and a hint naming the missing shell command and the substitute, instead of answering `text: ""` and "Clipboard updated".

**Workaround:** verify a copy flow from the app side — trigger the app's copy action, paste into a focused text field, and read that field back with `snapshot`. It proves the app's own clipboard write, which an adb-side read never did.

On a build that does implement `cmd clipboard`, note that Android 10+ restricts clipboard reads to the app with input focus or the current input method service (adb is neither), so an adb-side read can still come back blank there. `agent-device` reports the empty clipboard it was given rather than guessing at a denial it has not observed; if you have such a build, file it with the output of `adb shell cmd clipboard get text; echo rc=$?`.
