# Install timeout verification — 2026-10-30

Live source SHA: `9eea80f2a583e7b6b05d187114922506ee1fa3d0`. Subsequent changes simplify the test fake and preserve provider deployments that do not expose a separate readiness operation. Install subprocess bounds are unchanged.

Devices: Android 15 emulator `ReactNative_API_35B` (`emulator-5554`) and iOS 27.0 simulator `iPhone 17 Pro` (`BC54AC11-CD86-4C10-8C4E-5101C773FFEB`). The fixtures use `com.callstack.installtimeoutproof`.

The device-panel CLI sent install, reinstall, and URL-source commands to an isolated daemon built from this checkout. The Node API sent path-source commands because the CLI accepts only URL and CI sources. URL payloads were served through a temporary public HTTPS tunnel. Android AAB commands used the local bundletool fallback, with its two subprocesses bounded independently.

All 12 matrix cases succeeded. Each source case started after uninstalling the fixture. The final cleanup uninstalled it. `AGENT_DEVICE_EXEC_TRACE=true` saved subprocess bounds to each request log.

## Request evidence

### android-apk: install

Exit 0, success true. Request `2315096768d37af3`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"adb","timeoutMs":120000}]
```

### android-apk: reinstall

Exit 0, success true. Request `2f017324c2745848`.

```json
[{"command":"adb","timeoutMs":15000},{"command":"adb","timeoutMs":15000},{"command":"adb","timeoutMs":120000},{"command":"adb","timeoutMs":15000}]
```

### android-apk: source-path

Exit 0, success true. Request `a85ed6f4e7cfc7bf`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"adb","timeoutMs":120000}]
```

### android-apk: source-url

Exit 0, success true. Request `8dc8f16f9eb99abe`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"adb","timeoutMs":120000}]
```

### android-aab: install

Exit 0, success true. Request `7a2adfa89e465908`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"unzip","timeoutMs":15000},{"command":"aapt","timeoutMs":15000},{"command":"adb","timeoutMs":15000},{"command":"bundletool","timeoutMs":120000},{"command":"bundletool","timeoutMs":120000},{"command":"adb","timeoutMs":15000}]
```

### android-aab: reinstall

Exit 0, success true. Request `6af1acfe3ea0871b`.

```json
[{"command":"adb","timeoutMs":15000},{"command":"adb","timeoutMs":15000},{"command":"bundletool","timeoutMs":120000},{"command":"bundletool","timeoutMs":120000},{"command":"adb","timeoutMs":15000}]
```

### android-aab: source-path

Exit 0, success true. Request `bb9b953af572935e`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"unzip","timeoutMs":15000},{"command":"aapt","timeoutMs":15000},{"command":"adb","timeoutMs":15000},{"command":"bundletool","timeoutMs":120000},{"command":"bundletool","timeoutMs":120000},{"command":"adb","timeoutMs":15000}]
```

### android-aab: source-url

Exit 0, success true. Request `6b54c958085fee22`.

```json
[{"command":"unzip","timeoutMs":15000},{"command":"unzip","timeoutMs":15000},{"command":"aapt","timeoutMs":15000},{"command":"adb","timeoutMs":15000},{"command":"bundletool","timeoutMs":120000},{"command":"bundletool","timeoutMs":120000},{"command":"adb","timeoutMs":15000}]
```

### ios-simulator: install

Exit 0, success true. Request `47d1332d8f86ea45`.

```json
[{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"xcrun","timeoutMs":120000}]
```

### ios-simulator: reinstall

Exit 0, success true. Request `c99b595555fed5bc`.

```json
[{"command":"xcrun","timeoutMs":20000},{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"xcrun","timeoutMs":120000}]
```

### ios-simulator: source-path

Exit 0, success true. Request `edc59a0093f390e8`.

```json
[{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"xcrun","timeoutMs":120000}]
```

### ios-simulator: source-url

Exit 0, success true. Request `fe50368be865a97a`.

```json
[{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"plutil","timeoutMs":15000},{"command":"xcrun","timeoutMs":120000}]
```

## Ledger regression proof

At `9eea80f2a583e7b6b05d187114922506ee1fa3d0`, the same focused provider suite ran in a disposable checkout:

- Unmodified head: 19 passed.
- Restore the PR’s 330s/420s envelopes: 9 failed, 10 passed; failures report the missing daemon-result margin.
- Raise the real Android install/bundletool bound from 120s to 200s: 4 failed, 15 passed; the ledger captures the changed production call bounds.

Command: `pnpm exec vitest run --project provider-integration test/integration/provider-scenarios/install-timeout-ledger.test.ts --reporter verbose`. The disposable checkout was removed.

The ledger covers shutdown Android AVD discovery, boot polling, the changed serial, foreign device claims, metadata inspection, uninstall, APK install, both bundletool phases, simulator boot, CoreDevice readiness, and URL download. Archive extraction remains bounded by size, not wall-clock time. Provider-owned install implementations remain responsible for honoring the supplied timeout.

## Limits

No physical iOS device was available; its route has provider integration coverage. A separate live shutdown-AVD attempt stopped at selector validation: the device-panel CLI pins a running serial, does not select a stopped AVD by serial, and rejects clearing it. The 12 successful matrix cases used already booted targets.

No app session was opened. The temporary daemon, file server, and HTTPS tunnel are stopped after validation.
