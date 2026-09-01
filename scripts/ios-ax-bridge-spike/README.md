# iOS Simulator AX bridge spike

This bounded harness supplies the decision evidence for [#2192](https://github.com/callstack/agent-device/issues/2192). It compares host-side public macOS AX, the official idb `SimulatorFrameworkBridge` guest mechanism, and the #2189 XCTest control baseline behind one acquisition adapter. It does not select a production backend or change daemon, runner, open, relaunch, proxy, interaction, or public CLI behavior.

Build the repository and the repository-only spike helper first:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:ios-ax-bridge-spike
```

The rejected helper remains under this spike tooling package so it is reproducible without entering
the distributed `apple/macos-helper` package or npm artifact.

Use a newly created, task-owned iOS Simulator. The guest candidate uses the arm64 [idb release](https://github.com/facebook/idb/releases/tag/v1.5.2) outside this repository:

```sh
pnpm bench:ios-ax-bridge -- \
  --udid SIMULATOR_UDID \
  --target-process-id DEVICEHUB_PID \
  --candidate public-macos-ax,guest-simulator-framework-bridge,xctest-control \
  --state cold-cold,cold,warm,relaunch \
  --screen quiet,list,nested-scroll,alert,system-surface,xctest-stress \
  --samples 20 \
  --apply-preferences \
  --guest-companion /path/to/idb_companion \
  --guest-python python3 \
  --guest-site-packages /path/to/idb-cli/libexec/lib/python3.14/site-packages \
  --out .tmp/ios-ax-bridge-spike.v1.json.gz
```

The default candidate set, state set, screen set, and sample minimums come from the #2189 benchmark definitions. Each request carries an optional expected target generation and fixed request, response, node-count, traversal-depth, CPU, memory, and duration bounds. The public and guest helpers use newline-delimited responses; the guest adapter keeps one idb gRPC client and one `axbridge-persistent` reader alive across the run. Guest reads request idb's flat raw element form, preserving provider facts without importing visibility, hittability, scope, depth, or semantic compaction. Every sample keeps resource metrics and target status; each cell keeps one raw-tree exemplar with viewport, lineage, truncation, residue, and bounded diagnostics, plus separate prototype presentation measurements.

`--apply-preferences` is the only way the experiment edits Simulator preference plists. The Simulator must be shutdown; the harness records exact plist hashes and targeted key changes, then restores the original bytes before reporting. The keys are not production defaults. Omit `--private-tool` unless a disposable, compatible private mechanism is being tested; the harness never invents a private fallback.

The harness fails closed. It reports `NO-GO` when the guest candidate is unsupported, unavailable, unreadable, stale, over a bound, below the sample minimum, or when crash/timeout/cancellation recovery is not typed and recovered. Public AX is retained as a control result and cannot turn a passing guest corpus into a failure. It stops before reporting timings if the fixture app cannot be prepared deterministically. The adjacent gzipped JSON and readable Markdown report are the decision artifact; no production route should be implemented from a `NO-GO` run.
