# Original Android e2e benchmark, 2026-10-19

The original Android selection now ran against the original benchmark app.
Both agent-device base and PR head passed all 42 runnable cases without runner retries.
The earlier `examples/test-app` run did not establish this case parity.

The SDK code under test is `ddba75f5b474cb4cdac11b15f75292f2870396c7`.
The unchanged base is `eef1a3f76d7216da006ff59c975620c8b9dd7182`.
The app, runner, direct engine, tests, and configuration come from [tester-army/e2e#1234](https://github.com/tester-army/e2e/pull/1234), commit `2593e45025edc52b2c381e809b41cb63d5878e2b`.

## App and method

No downloadable APK was present in the releases or retained Android artifacts. Both retained artifact archives contained test evidence, not an APK. The workflow caches the native build with Actions cache. The downloaded source was built locally with its documented CI procedure: frozen dependencies, `pnpm build`, Expo prebuild, and `:app:assembleRelease` with JDK 17. The APK contains the pinned source's Release JavaScript and arm64-v8a native libraries. No app or test behavior was edited.

- App: `dev.e2e.benchmark`, version `1.0.0`, version code `1`.
- APK: `47,530,660` bytes; SHA-256 `b163e985ebd8340bf10447cdf6826aea37e429ee8c4382f9179c863c8c0619b2`.
- Device: `Pixel_7_CI`, `emulator-5554`, Android 16 / API 36.
- Host: darwin arm64, Node `26.8.1`; runner: e2e `0.21.2`.
- One worker; zero runner retries; animations enabled; Device panel stream attached.
- Same installed APK for all variants. Run order: PR head, base, direct.
- Each agent-device checkout had its own dependencies, build, Android helper artifacts, and daemon state directory. The temporary e2e checkout's `packages/mobile/node_modules/agent-device` symlink selected the checkout under test.

The original runner's `list --config e2e.android.config.ts` discovered 45 declarations. It selected 43 for Android and executed 42. Row containment is explicitly skipped in the source. The pointer-coordinate case and WebView case are iOS-only. Exact selected and runnable test identities match across all three reports; this is not a comparison of counts alone.

```sh
BENCH_ENGINE=agent-device AGENT_DEVICE_STATE_DIR=/absolute/isolated-state \
  ANDROID_SERIAL=emulator-5554 E2E_TELEMETRY_DISABLED=1 \
  node node_modules/e2e/dist/cli/bin.js run \
  --config e2e.android.config.ts --workers 1 --retries 0 --output .e2e/run-name
```

Run that command from `apps/mobile-benchmark`. To select the direct engine, omit `BENCH_ENGINE`. The direct server was built with `pnpm --filter @e2e-dev/android build:server`. The APK was installed before the runs; `E2E_MOBILE_BENCHMARK_ANDROID_APP` was unset.

## Exact suite results

| Variant | Passed | Failed | Source skip | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| Agent-device base | 42 | 0 | 1 | 327.95 s |
| Agent-device PR head | 42 | 0 | 1 | 321.25 s |
| Direct engine | 40 | 2 | 1 | 202.60 s |

This is one run per variant. The 6.70-second base/head difference is a diagnostic observation, not evidence of a substantial suite speedup. One Device-panel observation screenshot was taken during the head run. The direct run failed two assertions, so its duration does not establish an all-passing speedup.

The direct failures were `ACTION_FAILED` with an off-screen node:

- `controls.e2e.ts:271`, list counts/texts/reads/boxes: the scenario-row tap failed in `tests/fixtures.ts:81`, before the test body.
- `flows.e2e.ts:36`, modal and native alert: the `continue-button` tap failed at line 39.

Both cases passed on both agent-device variants. Every attempted case reported complete cleanup. The [case results](android-e2e-parity-2026-10-19-cases.json) include every declaration, selection flag, status, duration, report digest, and both failure details.

## Original operation benchmark

The original, unmodified `packages/android/bench/bench.ts --rounds 20` completed on base and head. Each invocation also ran the direct engine. The following table uses the direct samples paired with head. The [raw samples](android-e2e-parity-2026-10-19-operations.json) preserve each operation's count. Values are nearest-rank p50 milliseconds. Initialization has one sample; restart has three; other operations have 5–20. These small counts do not establish a startup improvement.

| Operation | Base | Head | Direct |
| --- | ---: | ---: | ---: |
| Prepare + init | 1530 | 1495 | 230 |
| Restart | 1169 | 868 | 469 |
| Observe home | 23.0 | 24.1 | 13.0 |
| Viewport swipe | 425 | 401 | 543 |
| Tap row until next screen visible | 426 | 420 | 178 |
| Back until list visible | 406 | 235 | 416 |
| Observe form | 19.0 | 18.1 | 18.6 |
| Locate test id | 17.9 | 17.1 | 1.7 |
| Tap | 120 | 67.7 | 38.3 |
| Fill, 19 characters | 972 | 760 | 14.1 |
| Keyboard type, 10 characters | 85.2 | 111 | 374 |
| Press Enter on node | 29.3 | 82.2 | 43.4 |
| Screenshot | 1448 | 311 | 65.9 |
| Observe with pixels | 1453 | 182 | 54.4 |

The complete operation table includes the typing and Enter rows that did not improve. Agent-device fill verifies its value across two observations separated by 150 ms; direct text replacement is a different completion contract.

## Remaining costs

The head suite's session recorded 762 snapshots totaling 89.16 seconds, 43 opens totaling 39.75 seconds, and 97 presses totaling 6.54 seconds. Its 88 e2e `locator.tap` steps totaled 106.77 seconds, including reads and readiness waits. These aggregates overlap and must not be added together.

The mobile engine's selected-suite configuration sets `transition: 1500`. Its `settled()` method waits for a new or moved target, then observes it again. The standalone operation benchmark uses the engine's 500 ms default. Pairing each of its 20 fill samples with the corresponding daemon request gives 516.8 ms p50 outside the head daemon, versus 521.7 ms on base. Verified daemon fill itself is 243 ms p50 on head, versus 452 ms on base. This consumer wait remains after native input becomes faster.

For the five screenshot-artifact calls, the corresponding daemon screenshot requests are 108 ms p50 on head, versus 1218 ms on base. The e2e screenshot API additionally observes the screen and decodes, masks, and re-encodes secure-field regions through `maskedScreenshot()` and `redactSecure()`. Its 311 ms head p50 therefore measures more than raw capture. Across all ten daemon screenshot requests, including the five pixel observations, head p50 is 58 ms.

The experiment's 2.4x all-passing suite gain has not been reproduced by this change. The result proves exact Android case coverage and faster input/capture primitives. Snapshot acquisition, consumer transition policy, app lifecycle, and screenshot redaction remain material costs.

Full reports, both benchmark pairings, and the APK are retained locally under `.tmp/e2e-1234-benchmark/`. The native source-helper probe reported `android-helper` and `helperVersion: 0.21.29-dev`. Each isolated daemon stopped with known cleanup and no orphaned claims. The disposable base checkout was removed after measurement.
