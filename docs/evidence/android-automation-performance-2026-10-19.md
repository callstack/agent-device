# Android automation performance, 2026-10-19

The comparison starts from `eef1a3f76d7216da006ff59c975620c8b9dd7182`.
The reference experiment is [tester-army/e2e#1234](https://github.com/tester-army/e2e/pull/1234), inspected at `2593e45025edc52b2c381e809b41cb63d5878e2b`.
Its measurements are author-reported. Its direct engine sets text through `ACTION_SET_TEXT`, injects input through `UiAutomation`, and captures screenshots inside its instrumentation process.

The follow-up [original-app comparison](android-e2e-parity-2026-10-19.md) runs the exact 42 Android cases and operation benchmark. Both agent-device variants passed all 42 cases; the direct engine passed 40 and failed two. The base/head suite times were 327.95/321.25 seconds. The fixture primitive gains below do not establish the reference experiment's total-suite gain.

## Reproduce

Use a dedicated Pixel 7 API 36 emulator and the current `examples/test-app` Release APK.
The local run used `Pixel_7_CI`, serial `emulator-5554`, Android 16, Node 26.8.1.
Animations remained enabled. The Device panel stream remained attached for both variants.
The APK came from the main-branch artifact `fingerprint.22184ce7fc5743fac60a0b5e673374310cea6154.android` (artifact `10611725290`, producer run `35529367803`) and was repacked with this checkout's JavaScript.

Build each checkout and its Android helpers separately. Run the variants in sequence on the same device and APK:

```sh
ANDROID_SERIAL=emulator-5554 BENCH_ROUNDS=20 \
  pnpm bench:android:automation /absolute/checkout /private/tmp/android-benchmark.json
```

The script uses the public SDK and the Checkout form's `field-email`.
It excludes locator snapshots from tap and fill timings.
Every fill is independently read back and checked.
The JSON contains raw samples, nearest-rank p50/p95, the checkout, version, serial, and observation time.
Open is one cold sample and is not evidence of a startup speedup.

## Causes and boundaries

- Ordinary taps and key events used `adb shell input` despite a live automation helper.
- Tap readiness and escape checks issued repeated window/activity dumps. Fresh app-window focus can answer the common case in process. System windows retain the diagnostic path.
- Fill cleared and committed text through IME broadcasts or shell commands. The helper can replace the selected editable node's text directly. It must still focus by tapping, raise the system keyboard when appropriate, preserve provider-native injection precedence, and verify the observed value.
- Fill's ownership probes repeated `dumpsys input_method` even when captured window provenance already identified the IME. Plain XML without window metadata retains the probe.
- Default screenshots enabled demo mode and waited one second. Immediate capture is the new default. `--normalize-status-bar` and SDK `stabilize: true` request the previous normalized, delayed capture.
- The helper retains fresh acquisition; none of these changes caches snapshot results.
- Mutation failures are not resent. Optional commands require the helper's advertised support. Timeout diagnostics omit encoded input payloads.

The direct experiment's 4.4 ms fill is not a verified-fill comparison. Agent-device retains two matching samples separated by 150 ms, plus identity, masking, formatting, and IME checks. This sets a latency floor above the reference text action alone.

## Test-app measurements

Twenty samples per steady-state operation; screenshots have ten and warm restarts have three. Values are milliseconds.

| Operation | Base p50 | Change p50 | Base p95 | Change p95 |
| --- | ---: | ---: | ---: | ---: |
| observe | 27.0 | 28.2 | 29.0 | 43.5 |
| tap | 105.8 | 52.5 | 131.5 | 71.8 |
| fill | 558.3 | 274.9 | 3296.9 | 320.1 |
| screenshot | 1237.9 | 69.1 | 1325.5 | 90.7 |
| restart | 1221.5 | 1439.0 | 1272.8 | 1747.7 |

Observe did not improve. Restarts did not improve in this three-sample run. The cold open had one sample per variant and must not be treated as a measured improvement.

Fill-owned captures skip the helper idle wait because the host already samples the live field until two observations agree across 150 ms. This request does not change session identity or the next public snapshot's idle policy.

## Validation

The complete test-app Android suite passed with no skipped scenarios: `152951 ms` on the final implementation. The run includes inventory, automation and rotation, Maestro selection, Unicode forms, system keyboard, capture and close, lifecycle and permission recovery, recording and performance artifacts, catalog traversal, checkout, gesture, and drag replays. Artifact: `test/artifacts/android-emulator/1792398951596-10411/coverage-report.json`.

The unchanged base passed the smoke selection in `61434 ms` and the three full-tier scenarios in `108610 ms`. These were separate invocations, so their sum is not a paired full-suite benchmark. The result does not establish the reference experiment's 2.4x total-suite gain.

Full-suite investigation exposed a pre-existing Android live-text bug on both base and the change: `get text id="automation-window"` resolved a node labeled `portrait` but read neighbouring `active` text at its former point. A minimal regression failed with `active` before the fix. The selected resource id, package, and class now reach the live read. A moved target returns its own text; a missing, cross-package, or duplicate identity cannot select a neighbour.

An early native-fill implementation omitted the keyboard-opening tap; the lifecycle scenario detected it and the focus tap was restored. One checkout submission miss occurred before the final synchronization and freshness hardening; six isolated checkout replays passed, so its cause was not established. The final combined suite passed, including every replay without retries.

Input-socket and screenshot-default regressions failed on unchanged production code (`3 failed, 17 passed`) and passed with the implementation. The focus-path regression also failed on unchanged base. The text-identity regression was observed red and green at its owning hierarchy seam, and its contract and daemon forwarding tests passed.

The broad unit selection initially exposed stale screenshot expectations, an inconsistent foreground fixture, and added eager imports. Their fixes passed 1,016 focused tests. The Android TV provider timeout also reproduced on unchanged base: its accepted IME installation was followed by an empty registration list. The fixture now reports the installed service; both Android provider scenario files passed seven tests without a timeout increase.
