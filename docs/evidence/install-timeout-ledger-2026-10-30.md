# Install timeout verification — 2026-10-30

Live source SHA: `9eea80f2a583e7b6b05d187114922506ee1fa3d0`. Subsequent changes simplify the test fake and preserve provider deployments that do not expose a separate readiness operation. Install subprocess bounds are unchanged.

Devices: Android 15 emulator `ReactNative_API_35B` (`emulator-5554`) and iOS 27.0 simulator `iPhone 17 Pro` (`BC54AC11-CD86-4C10-8C4E-5101C773FFEB`). The fixtures use `com.callstack.installtimeoutproof`.

The device-panel CLI sent install, reinstall, and URL-source commands to an isolated daemon built from this checkout. The Node API sent path-source commands because the CLI accepts only URL and CI sources. URL payloads were served through a temporary public HTTPS tunnel. Android AAB commands used the local bundletool fallback, with its two subprocesses bounded independently.

All 12 matrix cases succeeded. Each source case started after uninstalling the fixture. The final cleanup uninstalled it. `AGENT_DEVICE_EXEC_TRACE=true` saved subprocess bounds to each request log.

## Request evidence

All rows exited with code 0 and returned success. Timeouts are in milliseconds; repeated calls remain in their recorded order.

| Route | Operation | Request | Recorded timeouts |
| --- | --- | --- | --- |
| android-apk | install | `2315096768d37af3` | unzip=15000, adb=120000 |
| android-apk | reinstall | `2f017324c2745848` | adb=15000, adb=15000, adb=120000, adb=15000 |
| android-apk | source-path | `a85ed6f4e7cfc7bf` | unzip=15000, adb=120000 |
| android-apk | source-url | `8dc8f16f9eb99abe` | unzip=15000, adb=120000 |
| android-aab | install | `7a2adfa89e465908` | unzip=15000, unzip=15000, aapt=15000, adb=15000, bundletool=120000, bundletool=120000, adb=15000 |
| android-aab | reinstall | `6af1acfe3ea0871b` | adb=15000, adb=15000, bundletool=120000, bundletool=120000, adb=15000 |
| android-aab | source-path | `bb9b953af572935e` | unzip=15000, unzip=15000, aapt=15000, adb=15000, bundletool=120000, bundletool=120000, adb=15000 |
| android-aab | source-url | `6b54c958085fee22` | unzip=15000, unzip=15000, aapt=15000, adb=15000, bundletool=120000, bundletool=120000, adb=15000 |
| ios-simulator | install | `47d1332d8f86ea45` | plutil=15000, plutil=15000, plutil=15000, xcrun=120000 |
| ios-simulator | reinstall | `c99b595555fed5bc` | xcrun=20000, plutil=15000, plutil=15000, plutil=15000, xcrun=120000 |
| ios-simulator | source-path | `edc59a0093f390e8` | plutil=15000, plutil=15000, plutil=15000, xcrun=120000 |
| ios-simulator | source-url | `fe50368be865a97a` | plutil=15000, plutil=15000, plutil=15000, xcrun=120000 |

## Review follow-up: stopped AVD and current bindings

Live source SHA: `49ba34bdb29e008754a5ec61b4524c99b2082c6b`. A fresh isolated daemon ran the built plain CLI with `AGENT_DEVICE_EXEC_TRACE=true`. Android commands used `--platform android --device ReactNative_API_35B` without `--serial`. The AVD was shut down before each cold request; URL source installation also started with the fixture uninstalled.

```sh
agent-device install ./proof.apk --platform android --device ReactNative_API_35B
agent-device reinstall com.callstack.installtimeoutproof ./proof.apk --platform android --device ReactNative_API_35B
agent-device install-from-source https://<temporary-public-host>/proof.apk --platform android --device ReactNative_API_35B
```

All five requests exited 0 and returned success. Native exec traces record each install bound. A temporary Node spawn observer recorded unmodified subprocess arguments and PIDs; those PIDs join install arguments to the request trace. Emulator launches are counted within each request's journal interval. No providers or subprocess results were faked.

| Request | Operation | Emulator launches | Readiness `sys.boot_completed` probes | Install target | Install timeout |
| --- | --- | --- | --- | --- | --- |
| `795f69f4007e264c` | cold-install | 1 | 1 | `emulator-5554` | 120000 ms |
| `0a7b6d7f9a7b9707` | cold-reinstall | 1 | 1 | `emulator-5554` | 120000 ms |
| `40485b4773399c39` | cold-source | 1 | 1 | `emulator-5554` | 120000 ms |
| `5b86f1caf73508ae` | warm-install | 0 | 0 | `emulator-5554` | 120000 ms |
| `1138797a7845df53` | ios-install | 0 | 0 | `BC54AC11-CD86-4C10-8C4E-5101C773FFEB` | 120000 ms |

Each cold request ran exactly one `emulator -avd ReactNative_API_35B`, then readiness probes, then `adb -s emulator-5554 install -r <artifact>`. There was no second boot. The iOS request ran `xcrun simctl install BC54AC11-CD86-4C10-8C4E-5101C773FFEB <artifact>`. Both warm requests ran after the binding-cache changes.

The first plain-CLI attempt at `c1a190fd85` returned `DEVICE_NOT_FOUND`: install selection omitted stopped AVDs. The command declaration now owns `include-stopped`; advisory locks, provider context, claim admission, and handlers share that policy. This preserves one cached inventory selection per request, including provider deployments. The ledger inventory fake honors `running-only` instead of returning stopped AVDs unconditionally.

## Ledger regression proof

At `9eea80f2a583e7b6b05d187114922506ee1fa3d0`, the same focused provider suite ran in a disposable checkout:

- Unmodified head: 19 passed.
- Apply a reduced 330s/420s envelope mutation (the PR ships 480s/600s): 9 failed, 10 passed; failures report the missing daemon-result margin.
- Raise the real Android install/bundletool bound from 120s to 200s: 4 failed, 15 passed; the ledger captures the changed production call bounds.

Command: `pnpm exec vitest run --project provider-integration test/integration/provider-scenarios/install-timeout-ledger.test.ts --reporter verbose`. The disposable checkout was removed.

At `c1a190fd85`, isolated regression cases for source readiness and push pass (3 cases); restoring the prior production code gives 2 failures and 1 pass. The same-ID source case fails on stale materialization; the push case detects the absent 15s bound. At `7eac98d6f8`, the strengthened inventory ledger passes all 23 cases; removing the stopped-AVD selection fix gives 11 failures and 12 passes. Both experiments ran in a disposable checkout, which was removed.

The final ledger also covers a running emulator that becomes ready without changing its serial. Request binding caches distinguish the old and fresh boot observations. The ledger covers shutdown Android AVD discovery, boot polling, the changed serial, foreign device claims, metadata inspection, uninstall, APK install, both bundletool phases, simulator boot, CoreDevice readiness, and URL download. Archive extraction remains bounded by size, not wall-clock time. Provider-owned install implementations remain responsible for honoring the supplied timeout.

## Limits

No physical iOS device was available; its route has provider integration coverage. The original 12-case matrix used already booted targets; the follow-up above verifies the stopped AVD with the plain CLI.

No app session was opened. The temporary daemon, file server, and HTTPS tunnel are stopped after validation.
