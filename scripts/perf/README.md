# Command performance suite

`pnpm perf --platform ios` times every interaction command against the fixture app (`examples/test-app`).
The steps are in `ios-suite.ts`. Each step belongs to one scenario.
Each scenario starts from an untimed setup in every round.
The heavy-feed scenario uses a screen whose accessibility tree is deeper than 65 levels.
The suite records a reason for each catalog command that it does not time. `ios-suite.test.ts` keeps that list complete.
`pnpm perf --platform android` runs the older report-only Settings tour.

## Run locally

1. Run `pnpm build`. The suite drives the built CLI and the built SDK.
2. Use your own booted simulator. Install a current Release fixture on it. For the cached CI build and the JavaScript repack, see `examples/test-app/README.md`.
3. Set `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` to a path in your worktree.
4. Run the suite:

```sh
pnpm perf --platform ios --udid <udid> --rounds 3 --warmup 1 --out-dir .tmp/perf/local
```

`--rounds` is at least 3. `--scenarios lifecycle,heavy-feed` runs a subset. `--app-id` changes the fixture bundle id.
The suite uses its own temporary state directory and daemon. It stops them at the end.
At the end, or on SIGINT or SIGTERM, the suite saves the logs to `raw/state/`, stops the session and daemon within a deadline, and saves the logs again.

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
| `daemon` | The daemon request round trip that the client measures (`daemon_request`). For the pinned-backend capture (`home-reads/snapshot-forced-tree`, marked SDK in the report), the span of its request log. Comparisons use this metric. |
| `mean ± sd`, `cv` | The mean, the sample standard deviation, and the standard deviation divided by the mean. |
| `median`, `p95`, `min`, `max` | The median (the mean of the two middle values for an even count), the nearest-rank 95th percentile, and the extremes. |
| `runner` | The median sum of XCTest runner command times in one request. |
| `spawns` | The median count and time of host processes that one request started. |
| `snapshot source` | The median time of host accessibility-bridge acquisitions in one request. |
| `settle wait` | The median `settle.waitedMs` that a `--settle` response reports. |
| `stabilization` | The median time of post-gesture stabilization phases in one request. |
| `retries` | The failed attempts of retried operations in all successful samples. |
| `top phases` | The five phases with the largest median time per request. |
| `producer` | The number of samples that each snapshot producer answered (`simulator-ax-bridge`, `apple-runner`). |
| backends | The `snapshotQuality` backend, state, and reason code, for example `private-ax/recovered/ax-rejected`. |
| fallbacks | Degraded paths: snapshot-source errors, truncated recovery, and warn-level phases. |
| `fail` | The number of failed samples. `setup_failed` and `before_failed` mean that the untimed preparation failed. `daemon_stuck` means that an earlier request outlived its timeout; the suite restarts the daemon before the next scenario. `expectation_failed` means that the screen no longer has the shape that the step requires, for example the heavy-feed depth, or that a backend other than the pinned one served the pinned capture. |

## Nightly results

`.github/workflows/perf-nightly.yml` runs the iOS suite every night on `main`.
Each run uploads `perf-ios-summary` (summary, report, comparison; 90 days) and `perf-ios-raw` (logs; 30 days).
The job compares the run with up to seven earlier nights and writes the result to the job summary.
A night is the newest scheduled run of one UTC day that ran every scenario of the judged run.
Manual dispatches are never part of the rolling baseline.

To fetch and compare runs on your machine, use `gh` with access to the repository:

```sh
pnpm perf:compare                                  # latest night against the 7 nights before it
pnpm perf:compare --to 2026-10-28                  # that night against the 7 nights before it
pnpm perf:compare --to latest --from 2026-10-21    # latest against the newest run of that day
pnpm perf:compare --to latest --from 2026-10-21..2026-10-25 --out .tmp/perf/compare  # every run in the range
pnpm perf:compare --to .tmp/perf/local             # a local run against recent nights
```

A reference is `latest`, a run id, a `YYYY-MM-DD` date, or a local output path.
An explicit `--to` or `--from` reference accepts runs of any trigger, so it can compare dispatches and local runs.
Downloads stay in `.tmp/perf-nightly/<run-id>/`.
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
