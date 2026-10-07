---
title: Known Limitations
---

# Known Limitations

Platform constraints that change what you see during automation, and what to do instead.

## iOS: "Allow Paste" dialog never appears

iOS 16+ shows an "Allow Paste" system prompt when an app reads `UIPasteboard.general` in the foreground. When `agent-device` launches or activates an iOS app, it does so through the Apple runner (an XCUITest runner), and iOS silently grants pasteboard access in that context, so the prompt never appears.

This Apple platform constraint affects every XCUITest-based automation tool.

**Workarounds:**

- **Pre-fill the pasteboard** with the text the app will read, before it reads:
  ```bash
  agent-device clipboard write "some text" --platform ios --udid <simulator-udid>
  ```
- **Test the dialog manually.** XCUITest-based automation cannot exercise the "Allow Paste" UX.

## iOS simulator: `simctl pbcopy` writes nothing under Xcode 27

Under Xcode 27, `xcrun simctl pbcopy <udid>` exits 0 but leaves the simulator's pasteboard empty.
`simctl pbinfo` then lists a `Promised` item that reads back empty.

Use `agent-device clipboard write` instead: on an iOS simulator it writes the pasteboard from inside
the device and does not depend on `simctl pbcopy`. A tvOS simulator has no pasteboard that
`agent-device` can write from inside the device, so `clipboard write` on tvOS still uses
`simctl pbcopy` and is subject to this problem.

## Android: non-ASCII text on real devices needs `--test-ime`

`adb shell input text` cannot type non-ASCII text (for example Chinese characters or emoji) on any Android system image. `agent-device` installs its own headless test IME (`android-ime-helper`) to type that text. The test IME also keeps the on-screen system keyboard out of snapshots.

- **Emulators**: the test IME turns on automatically on `open`. Non-ASCII `fill` and `type` work without setup.
- **Real devices**: pass `--test-ime` to `open` to opt in. It is off by default on real hardware because a stuck helper IME leaves the real keyboard unavailable until restored. `agent-device` restores the previous IME when the session closes, and on daemon startup if a previous session crashed. If the keyboard still looks stuck, `agent-device doctor` flags it and prints the exact `adb shell ime set <id>` command that restores it.
- **`test` and `replay`**: pass `--test-ime` or `--no-test-ime` to the flow command, or set `testIme` in config. The setting applies to every session the flow run opens. Use this when a Maestro `eraseText` or non-ASCII `fill` step runs in a session the flow owns.

If a stale input session drops a `fill` commit, `agent-device` rebinds the helper and retries once. If it cannot confirm the rebind, text entry stops until it can. If keyboard restoration cannot read its recovery record, `close` reports a failure and keeps the record so startup recovery can retry.

If the helper cannot be installed (locked-down managed devices, some cloud providers), text entry falls back to ASCII-only `adb shell input text`, and non-ASCII `fill` and `type` report that they cannot enter the text.

## Android: first helper install can wait on an OEM install dialog

Some OEM builds make the first install of a package go through the system package installer, and `adb install` waits until someone confirms it on the device screen. This applies to both `agent-device` helper APKs (the snapshot helper and the test IME), once per package. On ColorOS (reported on an OPPO Find N6), the first install needs two taps: confirm the install, then dismiss the completion screen. Later installs of the same package are silent.

On such a device, an unattended first Android snapshot times out with a helper install failure. Its hint tells you to check the device screen for a pending install confirmation. Confirm the prompts on the device and retry. If no dialog is showing, restart the ADB server as the hint says.

## Android: WSL needs Linux platform-tools

Under WSL, the Windows `adb.exe` (for example from an `ANDROID_HOME` under `/mnt/c`) answers `adb version` but treats every host path as a Windows path, so recordings, pulls, and installs fail.

Install Linux Android platform-tools inside WSL, put them first on `PATH`, and point `ANDROID_HOME` at a Linux SDK. `agent-device doctor` fails the toolchain check with reason `android_adb_windows_binary_on_posix_host` when `adb` reports a Windows install path or reports that it is running on Windows. The same check catches a Windows `adb.exe` reached from macOS or Linux through WSL interop or Wine.

## Android: no clipboard access over adb on Android 16

On Android 16 (API 36), `adb shell cmd clipboard` exits with status **0** but never touches the clipboard; it prints `No shell command implementation.` on stderr. AOSP's clipboard service has no shell command implementation (not at `android13-release` through `android16-release`, nor on AOSP `main`), and physical devices ship the same service.

`agent-device` checks each device once and refuses instead of reporting a false success:

- `capabilities` omits `clipboard` on such a device.
- `clipboard read` and `clipboard write` fail with `UNSUPPORTED_OPERATION` and a hint naming the missing shell command and the substitute, instead of returning `text: ""` or "Clipboard updated".

**Workaround:** verify a copy flow from the app side. Trigger the app's copy action, paste into a focused text field, and read that field back with `snapshot`. This proves the app's own clipboard write, which an adb-side read never could.

On a build that does implement `cmd clipboard`, Android 10+ still restricts clipboard reads to the app with input focus or the current input method service, and adb is neither. An adb-side read can therefore come back blank. `agent-device` reports the empty clipboard it received rather than guessing at a denial. If you hit this on such a build, file an issue with the output of `adb shell cmd clipboard get text; echo rc=$?`.
