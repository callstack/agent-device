# Command performance suite

`pnpm perf` times every interaction command against the fixture app (`examples/test-app`) on iOS and on Android.
The steps are in `suite.ts`. Each step belongs to one scenario. Both platforms run the same scenarios.
A step runs on both platforms unless it names one platform. A step can replace its arguments, waits, or expectations on one platform.
Each scenario starts from an untimed setup in every round.
The heavy-feed scenario uses a screen whose accessibility tree is deeper than 65 levels on iOS and 60 levels on Android.
For each platform, the suite records a reason for each catalog command that it does not time. `suite.test.ts` keeps those lists complete.

## Run locally

1. Run `pnpm build`. The suite drives the built CLI and the built SDK.
2. Use your own booted simulator or emulator. Install a current Release fixture on it. For the cached CI build and the JavaScript repack, see `examples/test-app/README.md`.
3. For iOS, set `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` to a path in your worktree.
4. For Android, run `pnpm build:android` once. The snapshot helper APK must be in `android/snapshot-helper/dist/`.
5. Run the suite:

```sh
pnpm perf --platform ios --udid <udid> --rounds 3 --warmup 1 --out-dir .tmp/perf/ios
pnpm perf --platform android --serial <serial> --rounds 3 --warmup 1 --out-dir .tmp/perf/android
```

`--rounds` is at least 3. `--scenarios lifecycle,heavy-feed` runs a subset. `--app-id` changes the fixture bundle id or package name.
To install the cached Android Release fixture, use an empty download directory:

```sh
pnpm test-app:install
NAME="$(sh .github/actions/setup-fixture-app/resolve-artifact-name.sh android)"
RUN="$(gh api "repos/callstack/agent-device/actions/artifacts?name=$NAME" --jq '.artifacts[0].workflow_run.id')"
gh run download "$RUN" --repo callstack/agent-device --name "$NAME" --dir <download-dir>
tar -xzf <download-dir>/binary.tar.gz -C <download-dir>
ANDROID_HOME=<sdk> bash .github/actions/setup-fixture-app/repack-android-apk.sh <download-dir>/app-release.apk <apk-dir>/fixture-app.apk
adb -s <serial> install -r <apk-dir>/fixture-app.apk
```

The repack puts the current JavaScript into the cached native build.
If no artifact has the current fingerprint, build the APK as `.github/workflows/test-app-build-cache.yml` does.

The suite uses its own temporary state directory and daemon. It stops them at the end.
At the end, or on SIGINT or SIGTERM, the suite saves the logs to `raw/state/`, stops the session and daemon within a deadline, and saves the logs again.

## Snapshot paths

The heavy-feed scenario times the normal snapshot path and one forced path on each platform.

- iOS: the simulator accessibility bridge answers normal captures. `snapshot-raw-forced-tree` pins the XCTest tree backend through the SDK, because the CLI has no flag for it. On this screen, the tree backend must degrade to `sparse`.
- Android: the snapshot helper APK is the only snapshot engine (ADR 0002). Its persistent session answers normal captures. `snapshot-raw-one-shot` restarts the daemon with `AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION=0`, so a one-shot `am instrument` capture answers. The harness restarts the daemon without the variable after the step. Both raw captures must reach depth 56. The forced capture must report the `instrumentation` transport.

## Platform parity

These commands differ between the platforms. All other catalog commands run the same steps on both platforms.
Some shared steps use other screen coordinates or waits on Android. The `on.android` fields in `suite.ts` list them.

| Command | iOS | Android |
| --- | --- | --- |
| `action-button` | lifecycle | Not timed: Android has no key event for the Action button. |
| `prepare` | lifecycle (`prepare ios-runner`) | Not timed: `prepare` has only the `ios-runner` action. |
| `clipboard` | lifecycle ×2 | Not timed: the API 35 and 36 emulator images have no shell clipboard service. |
| `hardware-button` | Not timed: the simulator refuses hardware-button presses. | lifecycle (`hardware-button wake`) |
| `push` | Not timed: the fixture has no notification authorization. | lifecycle (adb broadcast) |
| `telephony` | Not timed: the simulator refuses calls and SMS. | lifecycle (`telephony sms`) |
| `snapshot` | heavy-feed: `snapshot-raw-forced-tree` | heavy-feed: `snapshot-raw-one-shot` |
| `audio` | Not timed: hosted runners grant no macOS audio permission. | Not timed: the Linux runner has no ScreenCaptureKit. |
| `fold` | Not timed: iPhone Duo only. | Not timed: foldable emulators only. |
| `tv-remote` | Not timed: tvOS only. | Not timed: Android TV only. |
| `hover`, `viewport` | Not timed: web targets only. | Not timed: web targets only. |
| `boot`, `shutdown`, `install`, `reinstall`, `uninstall`, `install-from-source` | Not timed: provisioning time dominates, or the command ends the session under test. | Same reason. |
| `replay`, `test` | Not timed: the sum of the commands that they run. | Same reason. |

Each run lists the measured commands and every reason in the Coverage section of `report.md`.

## Output

- `summary.json`: the machine-readable run (`agent-device-perf-summary/v1`). It holds the metadata, the coverage, and every sample.
- `report.md`: one table per scenario, the backends and fallbacks, the failures, and the coverage.
- `raw/state/`: the daemon log, and for each session `runner.log`, `events.ndjson`, and the `--debug` request log of each request. `requestId` in a sample names its request log.
- `raw/failures/`: the JSON response and stderr of each failed sample.

## Metrics

All times are milliseconds. Statistics use only the successful samples of a step.

| Metric | Meaning |
| --- | --- |
| `wall` | The CLI process time, from spawn to exit. |
| `daemon` | The daemon request round trip that the client measures (`daemon_request`). For the pinned-backend capture, the span of its request log. Comparisons use this metric. |
| `mean ± sd`, `cv` | The mean, the sample standard deviation, and the standard deviation divided by the mean. |
| `median`, `p95`, `min`, `max` | The median (the mean of the two middle values for an even count), the nearest-rank 95th percentile, and the extremes. |
| `runner` | The median sum of XCTest runner command times (iOS) or snapshot-helper gesture times (Android) in one request. |
| `spawns` | The median count and time of host processes, for example `xcrun` or `adb`, that one request started. |
| `snapshot source` | The median time of host accessibility-bridge acquisitions (iOS) or snapshot-helper captures (Android) in one request. |
| `settle wait` | The median `settle.waitedMs` that a `--settle` response reports. |
| `stabilization` | The median time of post-gesture stabilization phases in one request. |
| `retries` | The failed attempts of retried operations in all successful samples. |
| `top phases` | The five phases with the largest median time per request. |
| `producer` | The number of samples that each snapshot producer answered: `simulator-ax-bridge` and `apple-runner` on iOS; `android-helper/persistent-session` and `android-helper/instrumentation` (one-shot `am instrument`) on Android. |
| backends | The `snapshotQuality` backend, state, and reason code, for example `private-ax/recovered/ax-rejected` or `android-helper/healthy`. |
| fallbacks | Degraded paths: snapshot-source errors, truncated recovery, and warn-level phases. |
| `fail` | The number of failed samples. `setup_failed` and `before_failed` mean that the untimed preparation failed. `daemon_stuck` means that an earlier request outlived its timeout; the suite restarts the daemon before the next scenario. `restore_failed` means that the daemon restart after a forced-path step could not reopen the session. `expectation_failed` means that the screen no longer has the shape that the step requires, for example the heavy-feed depth, or that the forced path did not serve the capture. |

## Nightly results

`.github/workflows/perf-nightly.yml` runs the iOS suite and the Android suite every night on `main`.
iOS runs on a `macos-26` simulator. Android runs on an API 36 `pixel_7` emulator on a Linux KVM runner.
For each platform, a run uploads `perf-<platform>-summary` (summary, report, comparison; 90 days) and `perf-<platform>-raw` (logs; 30 days).
Each job compares its run with up to seven earlier nights of the same platform and writes the result to the job summary.
A night is the newest scheduled run of one UTC day that ran every scenario of the judged run.
Manual dispatches are never part of the rolling baseline.

To fetch and compare runs on your machine, use `gh` with access to the repository:

```sh
pnpm perf:compare                                  # latest iOS night against the 7 nights before it
pnpm perf:compare --platform android               # the same for Android
pnpm perf:compare --to 2026-10-28                  # that night against the 7 nights before it
pnpm perf:compare --to latest --from 2026-10-21    # latest against the newest run of that day
pnpm perf:compare --to latest --from 2026-10-21..2026-10-25 --out .tmp/perf/compare  # every run in the range
pnpm perf:compare --to .tmp/perf/local             # a local run against recent nights
```

A reference is `latest`, a run id, a `YYYY-MM-DD` date, or a local output path.
An explicit `--to` or `--from` reference accepts runs of any trigger, so it can compare dispatches and local runs.
`--platform` (default `ios`) selects the artifact. Every compared run must be of that platform.
Downloads stay in `.tmp/perf-nightly/<run-id>/<artifact>/`.
Do not judge a local run against CI nights. The comparison warns when the device, Xcode, or CPU differs.

## Comparison rule

The baseline of a step is the median of its nightly medians.
The noise of a step is the scaled median absolute deviation of those medians.
A step is a `regression` or an `improvement` only when its change is more than all of these:

- 20% of the baseline.
- Three times the night-to-night noise.
- Two times the coefficient of variation of the run divided by √n.
- 50 ms.

Each step gets a timing verdict and a failure verdict.
A timing verdict uses only successful samples:

- `insufficient-samples`: the judged run has fewer than three successful samples of the step.
- `insufficient-baseline`: fewer than three baseline nights have three successful samples of the step. Nights with fewer do not count.

The failure verdict compares failed samples with the worst baseline night:

- `new-failures`: the step failed and no baseline night failed.
- `more-failures`: the step failed more often than on every baseline night, both in count and in share of its samples.
- `fixed`: the step did not fail and every baseline night failed.

When failures are new or more, a faster median is `insufficient-samples`, not `improvement`.
The samples that still pass do not show that the step got faster.
Regressions and worse failures are workflow warnings. The job stays green.
The thresholds are in `compare.ts`.
