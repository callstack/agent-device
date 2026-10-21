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

`--scenarios lifecycle,heavy-feed` runs a subset. `--app-id` changes the fixture bundle id.
The suite uses its own temporary state directory and daemon. It stops them at the end.

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
| `fail` | The number of failed samples. `setup_failed` and `before_failed` mean that the untimed preparation failed. `daemon_stuck` means that an earlier request outlived its timeout; the suite restarts the daemon before the next scenario. `expectation_failed` means that the screen no longer has the shape that the step requires, for example the heavy-feed depth. |
