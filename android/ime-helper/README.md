# Android Test IME Helper

A minimal headless `InputMethodService` used as a deterministic, Unicode-safe text-entry backend
for local Android sessions. `onEvaluateInputViewShown()` returns `false` and
`onCreateInputView()` returns `null`, so activating this IME contributes zero accessibility nodes
to the UI tree -- no per-key `[group]+[text]` chrome, no clipboard/translate/voice-dictation
buttons -- unlike the real system keyboard (Gboard et al.), which pulls its visible keyboard into
the UIAutomator tree the moment a field is focused.

Text is injected through a dynamically-registered `BroadcastReceiver` carrying base64-encoded
UTF-8 Intent extras, the same `payloadBase64` convention `android-multitouch-helper` uses for the
same reason: `adb shell` re-tokenizes raw spaces, and base64 sidesteps that entirely. This makes
Unicode/CJK/emoji round-trip exactly, unlike `adb shell input text`, which is ASCII-only.

The helper is a service, not an instrumentation, so it cannot use `android-snapshot-helper`'s and
`android-multitouch-helper`'s `am instrument` invocation shape. It is installed and its version
verified the same way (bundled npm-packaged dist + version-keyed manifest.json), but invoked with
`adb shell ime enable`/`ime set` (lifecycle) and `adb shell am broadcast` (text entry) instead.

## Build

```sh
VERSION="$(node -p 'require("./package.json").version')"
sh ./scripts/build-android-ime-helper.sh "$VERSION" .tmp/android-ime-helper
```

## Run

```sh
PACKAGE="com.callstack.agentdevice.imehelper"
SERVICE="$PACKAGE/.TestInputMethodService"
VERSION="$(node -p 'require("./package.json").version')"

adb install -r -t ".tmp/android-ime-helper/agent-device-android-ime-helper-$VERSION.apk"

# Record the current default IME before switching, so it can be restored exactly.
PREVIOUS_IME="$(adb shell settings get secure default_input_method)"

adb shell ime enable "$SERVICE"
adb shell ime set "$SERVICE"

# Focus a text field, then inject Unicode-safe text via base64 extras. adb shell holds
# WRITE_SECURE_SETTINGS, which the receiver requires; a third-party app cannot.
TEXT_B64="$(printf '%s' '你好世界' | base64)"
adb shell am broadcast -p "$PACKAGE" \
  -a com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64 \
  --es text "$TEXT_B64"

# Clear the focused field.
adb shell am broadcast -p "$PACKAGE" -a com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT

# Restore the previous IME (critical -- do not skip on a real device).
adb shell ime set "$PREVIOUS_IME"
```

## Broadcast actions

The receiver is registered in the running IME process (so `getCurrentInputConnection()` is live)
but requires the **`android.permission.WRITE_SECURE_SETTINGS`** sender permission. adb shell
(uid 2000) holds that signature|privileged permission, but a co-installed third-party app cannot
be granted it, so it cannot deliver broadcasts to the receiver — the text-injection surface is
closed to other apps while the IME is active. (An earlier design used a manifest receiver with
`android:exported="false"` + explicit-component targeting, but on API 36 adb shell cannot deliver
to a non-exported component, which broke the CLI path; the permission gate is what actually works.)
Every extra is still treated as untrusted input: bounded length, defensive base64 decoding, and the
whole handler is wrapped so a malformed broadcast can never crash the IME process and strand a
field without an active input method.

- `ACTION_INPUT_TEXT_B64` (`--es text <base64 utf-8>`) -- commit decoded text at the cursor.
- `ACTION_INPUT_TEXT` (`--es text <string>`) -- commit text directly (subject to `adb shell`'s own
  tokenization; prefer the base64 variant for anything with spaces or non-ASCII).
- `ACTION_CLEAR_TEXT` -- select-all and commit an empty string.

An optional `--es protocol android-ime-helper-v1` extra is a defensive sanity check (not a
security boundary): if present and it doesn't match, the broadcast is dropped and logged.

## Restore hygiene

Switching the active IME is machine-global, not session-scoped. A crashed daemon that switched the
IME and never restored it leaves the device with an invisible keyboard -- on a real device, this
means the user cannot type anywhere until they manually reset their IME in Settings. The TS-side
lifecycle (`src/platforms/android/ime-lifecycle.ts`) persists the previously active IME to disk
before switching, restores it on session close/teardown, and best-effort restores any orphaned
switch left behind by a previous crashed daemon on startup.
